package automation

import (
	"encoding/json"
	"testing"

	"github.com/abhinavxd/libredesk/internal/automation/models"
	cmodels "github.com/abhinavxd/libredesk/internal/conversation/models"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/stretchr/testify/mock"
	"github.com/volatiletech/null/v9"
)

func keywordReplyRule(ruleType string, events ...string) models.Rule {
	rule := createTestRule(
		[]models.RuleGroup{{
			LogicalOp: models.OperatorAnd,
			Rules: []models.RuleDetail{{
				Field: models.ConversationContent, Operator: models.RuleOperatorContains,
				Value: "优惠券", FieldType: models.FieldTypeConversationField,
			}},
		}},
		[]models.RuleAction{{Type: models.ActionReply, Value: []string{"123456"}}},
		models.OperatorAnd,
	)
	rule.Type = ruleType
	rule.Events = events
	return rule
}

func TestMessageRulesMatchTriggeringMessage(t *testing.T) {
	for _, tt := range []struct {
		name      string
		message   string
		preview   string
		outgoing  bool
		new       bool
		reopened  bool
		wantReply bool
	}{
		{name: "first message", message: "有优惠券吗", preview: "later unrelated message", new: true, wantReply: true},
		{name: "later incoming message", message: "现在想问优惠券", preview: "hello", wantReply: true},
		{name: "reopening activity replaced preview", message: "优惠券", preview: "Conversation reopened", reopened: true, wantReply: true},
		{name: "unrelated followup ignores old keyword", message: "谢谢", preview: "优惠券"},
		{name: "image-only followup ignores old keyword", message: "", preview: "优惠券"},
		{name: "first message ignores later keyword", message: "hello", preview: "优惠券", new: true},
		{name: "outgoing event uses its own text", message: "优惠券说明", preview: "newer incoming message", outgoing: true, wantReply: true},
		{name: "outgoing ignores customer keyword", message: "hello", preview: "优惠券", outgoing: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := new(mockConversationStore)
			if tt.wantReply {
				store.On("ApplyAction", models.RuleAction{Type: models.ActionReply, Value: []string{"123456"}}, mock.Anything, umodels.User{}).Return(nil).Once()
			}
			engine := createQueueTestEngine(store)
			engine.rules = []models.Rule{
				keywordReplyRule(models.RuleTypeNewConversation),
				keywordReplyRule(models.RuleTypeConversationUpdate, models.EventConversationMessageIncoming, models.EventConversationMessageOutgoing),
			}
			conversation := createTestConversation(func(c *cmodels.Conversation) {
				c.ContactID = 42
				c.LastMessage = null.StringFrom(tt.preview)
			})
			message := cmodels.Message{Type: cmodels.MessageIncoming, SenderID: conversation.ContactID, TextContent: tt.message}
			eventType := models.EventConversationMessageIncoming
			if tt.outgoing {
				message.Type = cmodels.MessageOutgoing
				message.SenderID = 7
				eventType = models.EventConversationMessageOutgoing
			}
			var previousValues map[string]string
			if tt.reopened {
				previousValues = map[string]string{models.ConversationPreviousStatus: "3"}
				engine.rules[1].Groups[0].Rules = append(engine.rules[1].Groups[0].Rules, models.RuleDetail{
					Field: models.ConversationPreviousStatus, Operator: models.RuleOperatorEquals, Value: "3",
				})
			}

			engine.EvaluateMessageRules(conversation, message, tt.new, previousValues)
			if len(engine.taskQueue) != 1 {
				t.Fatalf("queued %d tasks, want exactly one", len(engine.taskQueue))
			}
			if conversation.LastMessage.String != tt.preview {
				t.Fatal("message rule changed the conversation used by other hooks")
			}
			// A later message or activity must not change the already queued content.
			conversation.LastMessage = null.StringFrom("a subsequent conversation update")
			message.TextContent = "a subsequent message"
			task := <-engine.taskQueue
			if tt.new {
				if task.taskType != NewConversation {
					t.Fatalf("first message queued task type %q", task.taskType)
				}
				engine.handleNewConversation(task.conversation)
			} else {
				if task.taskType != UpdateConversation || task.eventType != eventType {
					t.Fatalf("wrong message event: task=%q event=%q", task.taskType, task.eventType)
				}
				engine.handleUpdateConversation(task.conversation, task.eventType, task.previousValues)
			}
			wantCount := 0
			if tt.wantReply {
				wantCount = 1
			}
			if store.callCount != wantCount {
				t.Fatalf("replies = %d, want %d", store.callCount, wantCount)
			}
			store.AssertExpectations(t)
		})
	}
}

func TestMessageRulesSkipMachineGeneratedOutgoing(t *testing.T) {
	for _, tt := range []struct {
		name     string
		senderID int
		meta     json.RawMessage
	}{
		{name: "system reply", senderID: testSystemUserID},
		{name: "automated reply sent as agent", senderID: 7, meta: json.RawMessage(`{"is_automated":true}`)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			engine := createQueueTestEngine(new(mockConversationStore))
			engine.EvaluateMessageRules(createTestConversation(), cmodels.Message{
				Type: cmodels.MessageOutgoing, TextContent: "优惠券：123456", SenderID: tt.senderID, Meta: tt.meta,
			}, false, nil)
			if len(engine.taskQueue) != 0 {
				t.Fatal("an automatic reply queued another automation event")
			}
		})
	}
}

func TestMessageRulesIncomingSubscriptionIgnoresAgentReplies(t *testing.T) {
	store := new(mockConversationStore)
	engine := createQueueTestEngine(store)
	engine.rules = []models.Rule{keywordReplyRule(models.RuleTypeConversationUpdate, models.EventConversationMessageIncoming)}
	engine.EvaluateMessageRules(createTestConversation(), cmodels.Message{
		Type: cmodels.MessageOutgoing, SenderID: 7, TextContent: "优惠券",
	}, false, nil)
	if len(engine.taskQueue) != 1 {
		t.Fatal("human outgoing message was not queued")
	}
	task := <-engine.taskQueue
	engine.handleUpdateConversation(task.conversation, task.eventType, task.previousValues)
	if store.callCount != 0 {
		t.Fatal("incoming-only keyword rule replied to an agent message")
	}
}
