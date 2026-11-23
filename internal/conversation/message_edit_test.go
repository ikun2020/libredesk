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

	const editedText = "updated."
	edit, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, agent, `<p><strong>updated</strong><script>alert(1)</script></p>`, false)
	if err != nil || edit["edited_at"] == nil || edit["text_content"] != editedText || strings.Contains(edit["content"].(string), "script") {
		t.Fatalf("incorrect edit result: %v, %v", edit, err)
	}
	chat, err := m.GetChatConversation(conv.UUID)
	if err != nil || chat.LastChatMessage.UUID != target.UUID || chat.LastChatMessage.Content != editedText || chat.UnreadMessageCount != 2 {
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

func TestRecallAutomatedLiveChatMessagesPreservesAccessAndPreviews(t *testing.T) {
	db := testutil.NewDB(t, "message_recall_automated")
	lo := logf.New(logf.Opts{})
	m := &Manager{db: db, lo: &lo, i18n: testutil.NewI18n(t), wsHub: ws.NewHub(&lo, nil), inboxStore: messageEditTestInbox{}}
	if err := dbutil.ScanSQLFile("queries.sql", &m.q, db, efs); err != nil {
		t.Fatal(err)
	}
	insertUser := func(typ, email string) int {
		t.Helper()
		var id int
		if err := db.Get(&id, `INSERT INTO users (type, email, first_name, last_name) VALUES ($1, $2, $2, '') RETURNING id`, typ, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	agent := umodels.User{
		ID: insertUser(umodels.UserTypeAgent, "recall-agent@example.com"), Type: umodels.UserTypeAgent, Enabled: true,
		Permissions: []string{authzmodels.PermMessagesWrite, authzmodels.PermConversationsRead, authzmodels.PermConversationsReadAll},
	}
	systemID := insertUser(umodels.UserTypeAgent, umodels.SystemUserEmail)
	assistantID := insertUser(umodels.UserTypeAIAssistant, "recall-ai@example.com")
	otherAgentID := insertUser(umodels.UserTypeAgent, "recall-other@example.com")
	contactID := insertUser(umodels.UserTypeContact, "recall-customer@example.com")
	var inboxID int
	if err := db.Get(&inboxID, `INSERT INTO inboxes (name, channel) VALUES ('Support', 'livechat') RETURNING id`); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name        string
		senderID    int
		meta        string
		private     bool
		activity    bool
		noAccess    bool
		allowRecall bool
	}{
		{name: "system automation", senderID: systemID, meta: `{"is_automated":true}`, allowRecall: true},
		{name: "automation using actor identity", senderID: agent.ID, meta: `{"is_automated":true}`, allowRecall: true},
		{name: "AI metadata on agent identity", senderID: otherAgentID, meta: `{"ai_assistant_id":7}`, allowRecall: true},
		{name: "AI assistant identity", senderID: assistantID, meta: `{}`, allowRecall: true},
		{name: "other human", senderID: otherAgentID, meta: `{}`},
		{name: "CSAT", senderID: systemID, meta: `{"is_automated":true,"is_csat":true}`},
		{name: "continuity email", senderID: systemID, meta: `{"is_automated":true,"continuity_email":true}`},
		{name: "campaign invitation", senderID: agent.ID, meta: `{"campaign_id":"campaign"}`},
		{name: "private automation note", senderID: systemID, meta: `{"is_automated":true}`, private: true},
		{name: "system activity", senderID: systemID, meta: `{"is_automated":true}`, private: true, activity: true},
		{name: "inaccessible conversation", senderID: assistantID, meta: `{"ai_assistant_id":7}`, noAccess: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var conv models.Conversation
			if err := db.Get(&conv, `INSERT INTO conversations (contact_id, inbox_id, status_id, contact_last_seen_at)
				VALUES ($1, $2, (SELECT id FROM conversation_statuses LIMIT 1), NOW() - INTERVAL '1 hour') RETURNING id, uuid`, contactID, inboxID); err != nil {
				t.Fatal(err)
			}
			insert := func(senderID int, content, meta, age, messageType string, private bool) models.Message {
				t.Helper()
				var message models.Message
				if err := db.Get(&message, `INSERT INTO conversation_messages (conversation_id, type, status, sender_id, sender_type, content, text_content, content_type, private, meta, created_at)
					VALUES ($1, $2, 'sent', $3, 'agent', $4, $4, 'text', $5, $6::jsonb, NOW() - $7::interval)
					RETURNING id, uuid, sender_id, created_at`, conv.ID, messageType, senderID, content, private, meta, age); err != nil {
					t.Fatal(err)
				}
				if err := m.UpdateConversationLastMessage(conv.ID, conv.UUID, content, models.SenderTypeAgent, messageType, private, message.CreatedAt, senderID); err != nil {
					t.Fatal(err)
				}
				return message
			}
			previous := insert(agent.ID, "previous public reply", `{}`, "2 min", models.MessageOutgoing, false)
			messageType := models.MessageOutgoing
			if test.activity {
				messageType = models.MessageActivity
			}
			target := insert(test.senderID, "automatic public reply", test.meta, "1 min", messageType, test.private)
			actor := agent
			if test.noAccess {
				actor.Permissions = []string{authzmodels.PermMessagesWrite, authzmodels.PermConversationsRead, authzmodels.PermConversationsReadAssigned}
			}
			if _, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, actor, "<p>edited automatic reply</p>", false); err == nil {
				t.Fatal("automated, AI or another user's message could be edited")
			}
			if test.allowRecall {
				before, err := m.GetChatConversation(conv.UUID)
				if err != nil || before.LastChatMessage.UUID != target.UUID || before.UnreadMessageCount != 2 {
					t.Fatalf("unexpected public state before recall: %#v, %v", before, err)
				}
			}
			update, err := m.ChangeLiveChatMessage(conv.UUID, target.UUID, actor, "", true)
			if !test.allowRecall {
				if err == nil {
					t.Fatal("recall bypassed the target or conversation restrictions")
				}
				var content string
				if err := db.Get(&content, `SELECT content FROM conversation_messages WHERE id = $1`, target.ID); err != nil || content != "automatic public reply" {
					t.Fatalf("denied recall changed the message: %q, %v", content, err)
				}
				return
			}
			if err != nil || update["recalled_at"] == nil || update["content"] != "" {
				t.Fatalf("automatic reply recall failed: %#v, %v", update, err)
			}
			var snapshot struct {
				LastMessage         string `db:"last_message"`
				LastMessageSenderID int    `db:"last_message_sender_id"`
				LastInteraction     string `db:"last_interaction"`
			}
			if err := db.Get(&snapshot, `SELECT last_message, last_message_sender_id, last_interaction FROM conversations WHERE id = $1`, conv.ID); err != nil {
				t.Fatal(err)
			}
			if snapshot.LastMessage != "previous public reply" || snapshot.LastInteraction != "previous public reply" || snapshot.LastMessageSenderID != agent.ID {
				t.Fatalf("staff/public snapshots retained the recalled sender's message: %+v", snapshot)
			}
			after, err := m.GetChatConversation(conv.UUID)
			if err != nil || after.LastChatMessage.UUID != previous.UUID || after.LastChatMessage.Content != "previous public reply" || after.UnreadMessageCount != 1 {
				t.Fatalf("incorrect public preview or unread count after recall: %#v, %v", after, err)
			}
		})
	}
}
