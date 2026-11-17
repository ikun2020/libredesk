package conversation

import (
	"strings"
	"testing"

	authzmodels "github.com/abhinavxd/libredesk/internal/authz/models"
	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/dbutil"
	"github.com/abhinavxd/libredesk/internal/inbox"
	"github.com/abhinavxd/libredesk/internal/testutil"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/abhinavxd/libredesk/internal/ws"
	"github.com/zerodha/logf"
)

type messageEditTestInbox struct{ inboxStore }

func (messageEditTestInbox) Get(int) (inbox.Inbox, error) { return nil, nil }

func TestChangeLiveChatMessagePreservesPaginationAndPreviews(t *testing.T) {
	db := testutil.NewDB(t, "message_edit")
	lo := logf.New(logf.Opts{})
	m := &Manager{db: db, lo: &lo, i18n: testutil.NewI18n(t), wsHub: ws.NewHub(&lo, nil), inboxStore: messageEditTestInbox{}}
	if err := dbutil.ScanSQLFile("queries.sql", &m.q, db, efs); err != nil {
		t.Fatal(err)
	}

	agent := umodels.User{
		Type:        umodels.UserTypeAgent,
		Enabled:     true,
		Permissions: []string{authzmodels.PermMessagesWrite, authzmodels.PermConversationsRead, authzmodels.PermConversationsReadAll},
	}
	var conv models.Conversation
	if err := db.Get(&agent.ID, `INSERT INTO users (type, first_name, last_name) VALUES ('agent', 'Agent', '') RETURNING id`); err != nil {
		t.Fatal(err)
	}
	if err := db.Get(&conv.ContactID, `INSERT INTO users (type, first_name, last_name) VALUES ('contact', 'Customer', '') RETURNING id`); err != nil {
		t.Fatal(err)
	}
	if err := db.Get(&conv.InboxID, `INSERT INTO inboxes (name, channel) VALUES ('Support', 'livechat') RETURNING id`); err != nil {
		t.Fatal(err)
	}
	if err := db.Get(&conv, `INSERT INTO conversations (contact_id, inbox_id, status_id, contact_last_seen_at)
		VALUES ($1, $2, (SELECT id FROM conversation_statuses LIMIT 1), NOW() - INTERVAL '1 hour') RETURNING id, uuid`, conv.ContactID, conv.InboxID); err != nil {
		t.Fatal(err)
	}
	insert := func(content string, age string, private bool) models.Message {
		t.Helper()
		var msg models.Message
		if err := db.Get(&msg, `INSERT INTO conversation_messages (conversation_id, type, status, sender_id, sender_type, content, text_content, content_type, private, created_at)
			VALUES ($1, 'outgoing', 'sent', $2, 'agent', $3, $3, 'text', $4, NOW() - $5::interval) RETURNING uuid, created_at`, conv.ID, agent.ID, content, private, age); err != nil {
			t.Fatal(err)
		}
		if err := m.UpdateConversationLastMessage(conv.ID, conv.UUID, content, models.SenderTypeAgent, models.MessageOutgoing, private, msg.CreatedAt, agent.ID); err != nil {
			t.Fatal(err)
		}
		return msg
	}
	older := insert("previous message", "6 min", false)
	target := insert("original message", "1 min", false)
	note := insert("private note", "0 min", true)

	visitor := agent
	visitor.ID, visitor.Type = conv.ContactID, umodels.UserTypeContact
	if _, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, visitor, "", true); err == nil {
		t.Fatal("visitor could recall an agent message")
	}
	if _, err := m.ChangeLiveChatMessage(conv.UUID, older.UUID, agent, "<p>too late</p>", false); err == nil {
		t.Fatal("agent could edit a message older than five minutes")
	}
	if _, err := m.ChangeLiveChatMessage(conv.UUID, note.UUID, agent, "", true); err == nil {
		t.Fatal("public recall endpoint accepted a private note")
	}

	edit, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, agent, `<p><strong>updated</strong><script>alert(1)</script></p>`, false)
	if err != nil || edit["edited_at"] == nil || edit["text_content"] != "updated" || strings.Contains(edit["content"].(string), "script") {
		t.Fatalf("incorrect edit result: %v, %v", edit, err)
	}
	chat, err := m.GetChatConversation(conv.UUID)
	if err != nil || chat.LastChatMessage.UUID != target.UUID || chat.LastChatMessage.Content != "updated" || chat.UnreadMessageCount != 2 {
		t.Fatalf("incorrect preview after edit: %v, %v", chat, err)
	}

	recall, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, agent, "", true)
	if err != nil || recall["recalled_at"] == nil || recall["content"] != "" {
		t.Fatalf("incorrect recall result: %v, %v", recall, err)
	}
	chat, err = m.GetChatConversation(conv.UUID)
	if err != nil || chat.LastChatMessage.UUID != older.UUID || chat.LastChatMessage.Content != "previous message" || chat.UnreadMessageCount != 1 {
		t.Fatalf("incorrect preview after recall: %v, %v", chat, err)
	}
	if _, err := m.GetMessage(target.UUID); err == nil {
		t.Fatal("recalled message remained available by UUID")
	}
	private := false
	visible, _, err := m.GetConversationMessages(conv.UUID, 1, 10, &private, nil)
	if err != nil || len(visible) != 1 || visible[0].UUID != older.UUID {
		t.Fatalf("recalled message remained in public history: %#v, %v", visible, err)
	}
	slots, _, err := m.GetAgentConversationMessages(conv.UUID, 1, 2, nil, nil)
	if err != nil || len(slots) != 2 || slots[0].UUID != note.UUID || slots[1].UUID != target.UUID ||
		slots[1].RecalledAt == nil || slots[1].Content != "" || len(slots[1].Attachments) != 0 {
		t.Fatalf("agent history lost its pagination slot: %#v, %v", slots, err)
	}
	slots, _, err = m.GetAgentConversationMessages(conv.UUID, 2, 2, nil, nil)
	if err != nil || len(slots) != 1 || slots[0].UUID != older.UUID {
		t.Fatalf("agent pagination skipped the previous message: %#v, %v", slots, err)
	}
	if _, err := m.ChangeLiveChatMessage(conv.UUID, older.UUID, agent, "", true); err != nil {
		t.Fatalf("recall was incorrectly limited to five minutes: %v", err)
	}
}
