package conversation

import (
	"database/sql"
	"errors"
	"slices"
	"strings"

	"github.com/abhinavxd/libredesk/internal/authz"
	authzmodels "github.com/abhinavxd/libredesk/internal/authz/models"
	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	"github.com/abhinavxd/libredesk/internal/stringutil"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/microcosm-cc/bluemonday"
)

var liveChatEditSanitizer = func() *bluemonday.Policy {
	policy := bluemonday.UGCPolicy()
	policy.AllowURLSchemes("cid")
	policy.AllowStyles("text-align").OnElements("p", "div", "h1", "h2", "h3")
	policy.AllowStyles("text-decoration").OnElements("span")
	return policy
}()

// ChangeLiveChatMessage edits or recalls an agent's public web chat message and broadcasts the committed changes.
func (m *Manager) ChangeLiveChatMessage(conversationUUID, messageUUID string, agent umodels.User, content string, recall bool) (map[string]any, error) {
	denied := func() error {
		return envelope.NewError(envelope.PermissionError, m.i18n.T("status.deniedPermission"), nil)
	}
	if agent.Type != umodels.UserTypeAgent || !agent.Enabled || agent.Email.String == umodels.SystemUserEmail ||
		!slices.Contains(agent.Permissions, authzmodels.PermMessagesWrite) {
		return nil, denied()
	}
	var textContent string
	if recall {
		content = ""
	} else {
		content = rewriteInlineImagesToCID(liveChatEditSanitizer.Sanitize(stringutil.SanitizeUTF8(content)))
		textContent = stringutil.HTML2Text(content)
		if strings.TrimSpace(textContent) == "" {
			return nil, envelope.NewError(envelope.InputError, m.i18n.Ts("globals.messages.empty", "name", m.i18n.T("globals.terms.message")), nil)
		}
	}

	tx, err := m.db.Beginx()
	if err != nil {
		return nil, m.liveChatMessageChangeError(err)
	}
	defer tx.Rollback()

	var conversation models.Conversation
	if err := tx.Stmtx(m.q.LockLiveChatMessageConversation).Get(&conversation, conversationUUID); err != nil {
		return nil, m.liveChatMessageChangeError(err)
	}
	if !authz.CanReadAssignment(agent, conversation.AssignedUserID, conversation.AssignedTeamID) {
		return nil, denied()
	}
	message := models.Message{ConversationUUID: conversationUUID}
	if err := tx.Stmtx(m.q.ChangeLiveChatMessage).Get(&message, conversation.ID, messageUUID, agent.ID, recall, content, textContent); err != nil {
		return nil, m.liveChatMessageChangeError(err)
	}
	if recall {
		if _, err := tx.Stmtx(m.q.UnlinkRecalledMessageMedia).Exec(message.ID); err != nil {
			return nil, m.liveChatMessageChangeError(err)
		}
	}

	var preview models.ConversationListItem
	err = tx.Stmtx(m.q.RefreshLiveChatMessagePreviews).Get(&preview, conversation.ID, message.CreatedAt, agent.ID,
		m.i18n.T("globals.terms.image"), m.i18n.T("globals.terms.video"), m.i18n.T("globals.terms.audio"), m.i18n.T("globals.terms.file"))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, m.liveChatMessageChangeError(err)
	}
	var chat models.ChatConversation
	if err := tx.Stmtx(m.q.GetChatConversation).Get(&chat, conversationUUID); err != nil {
		return nil, m.liveChatMessageChangeError(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, m.liveChatMessageChangeError(err)
	}

	if !recall {
		m.RenderArticleReferences(&message)
		m.resolveEditedLiveChatImages(&message)
	}
	update := map[string]any{
		"conversation_uuid": conversationUUID,
		"uuid":              message.UUID,
		"content":           message.Content,
		"text_content":      message.TextContent,
		"content_type":      message.ContentType,
		"updated_at":        message.UpdatedAt,
	}
	if recall {
		update["recalled_at"] = message.RecalledAt
	} else {
		update["edited_at"] = message.EditedAt
	}
	m.BroadcastMessageUpdate(conversationUUID, message.UUID, update)
	if !preview.UpdatedAt.IsZero() {
		m.BroadcastConversationUpdate(conversationUUID, map[string]any{
			"last_message":            preview.LastMessage,
			"last_message_at":         preview.LastMessageAt,
			"last_message_sender":     preview.LastMessageSender,
			"last_interaction":        preview.LastInteraction,
			"last_interaction_at":     preview.LastInteractionAt,
			"last_interaction_sender": preview.LastInteractionSender,
			"updated_at":              preview.UpdatedAt,
		})
	}

	inboxInstance, err := m.inboxStore.Get(conversation.InboxID)
	if widget, ok := inboxInstance.(*livechat.LiveChat); err == nil && ok {
		m.SignAvatarURL(&chat.LastChatMessage.Author.AvatarURL)
		m.SignAttachmentURLs(chat.LastChatMessage.Attachments)
		widgetUpdate := make(map[string]any, len(update)+2)
		for key, value := range update {
			widgetUpdate[key] = value
		}
		widgetUpdate["conversation_last_message"] = chat.LastChatMessage
		widgetUpdate["unread_message_count"] = chat.UnreadMessageCount
		widget.BroadcastMessageUpdateToClients(conversation.ContactID, widgetUpdate)
	}
	return update, nil
}

func (m *Manager) liveChatMessageChangeError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return envelope.NewError(envelope.NotFoundError, m.i18n.Ts("globals.messages.notFound", "name", m.i18n.T("globals.terms.message")), nil)
	}
	m.lo.Error("error changing live chat message", "error", err)
	return envelope.NewError(envelope.GeneralError, m.i18n.T("globals.messages.somethingWentWrong"), nil)
}

// resolveEditedLiveChatImages restores signed sources for inline attachments saved as CIDs.
func (m *Manager) resolveEditedLiveChatImages(message *models.Message) {
	if message.EditedAt == nil {
		return
	}
	refs, err := m.GetInlineMediaRefs(message)
	if err != nil {
		m.lo.Error("error resolving edited live chat image", "message_uuid", message.UUID, "error", err)
		return
	}
	for _, ref := range refs {
		url := m.mediaStore.GetURL(ref.UUID, ref.ContentType, ref.Filename)
		message.Content = strings.ReplaceAll(message.Content, "cid:"+ref.ContentID, url)
	}
	for _, attachment := range message.Attachments {
		if attachment.ContentID != "" && attachment.URL != "" {
			message.Content = strings.ReplaceAll(message.Content, "cid:"+attachment.ContentID, attachment.URL)
		}
	}
}
