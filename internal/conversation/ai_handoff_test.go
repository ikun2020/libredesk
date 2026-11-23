package conversation

import (
	"database/sql"
	"errors"
	"strconv"
	"testing"

	amodels "github.com/abhinavxd/libredesk/internal/automation/models"
	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/dbutil"
	"github.com/abhinavxd/libredesk/internal/testutil"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/zerodha/logf"
)

type handoffAssignmentUsers struct {
	userStore
	assistant umodels.User
}

func (s handoffAssignmentUsers) GetSystemUser() (umodels.User, error) {
	return umodels.User{ID: 100, FirstName: "System"}, nil
}

func (s handoffAssignmentUsers) GetAgentCachedOrLoad(id int) (umodels.User, error) {
	if id != s.assistant.ID {
		return umodels.User{}, sql.ErrNoRows
	}
	return s.assistant, nil
}

func TestAIHandoffAssignment(t *testing.T) {
	db := testutil.NewDB(t, "ai_handoff_assignment")
	logger := logf.New(logf.Opts{})
	m := Manager{lo: &logger, i18n: testutil.NewI18n(t)}
	if err := dbutil.ScanSQLFile("queries.sql", &m.q, db, efs); err != nil {
		t.Fatal(err)
	}

	insertID := func(query string, args ...any) int {
		t.Helper()
		var id int
		if err := db.Get(&id, query, args...); err != nil {
			t.Fatal(err)
		}
		return id
	}
	contactID := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('contact', 'Customer', '') RETURNING id")
	humanID := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('agent', 'Human', '') RETURNING id")
	assistantUserID := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('ai_assistant', 'Assistant', '') RETURNING id")
	assistantID := insertID("INSERT INTO ai_assistants (user_id) VALUES ($1) RETURNING id", assistantUserID)
	teamID := insertID("INSERT INTO teams (name, conversation_assignment_type) VALUES ('Support', 'Manual') RETURNING id")
	inboxID := insertID("INSERT INTO inboxes (name, channel) VALUES ('Chat', 'livechat') RETURNING id")
	m.userStore = handoffAssignmentUsers{assistant: umodels.User{ID: assistantUserID, Type: umodels.UserTypeAIAssistant, Enabled: true}}

	newConversation := func(t *testing.T, assigneeID any) string {
		t.Helper()
		var uuid string
		err := db.Get(&uuid, `INSERT INTO conversations (contact_id, inbox_id, status_id, assigned_user_id, assigned_team_id, meta)
			VALUES ($1, $2, (SELECT id FROM conversation_statuses WHERE name = 'Open'), $3, $4, '{"source":"chat"}')
			RETURNING uuid`, contactID, inboxID, assigneeID, teamID)
		if err != nil {
			t.Fatal(err)
		}
		return uuid
	}
	assign := func(t *testing.T, uuid string, assigneeID int, blockAutomaticAI, resumeAI bool, wantRows int64) {
		t.Helper()
		result, err := m.q.UpdateConversationAssignedUser.Exec(uuid, assigneeID, blockAutomaticAI, resumeAI)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != wantRows {
			t.Fatalf("assign %d: affected %d rows, error %v, want %d rows", assigneeID, rows, err, wantRows)
		}
	}
	checkAssignment := func(t *testing.T, uuid string, wantAssignee int, wantHandoff string) {
		t.Helper()
		var assignee, team int
		var handoff, source string
		err := db.QueryRow(`SELECT COALESCE(assigned_user_id, 0), COALESCE(assigned_team_id, 0),
			COALESCE(meta->>'ai_handoff', ''), COALESCE(meta->>'source', '')
			FROM conversations WHERE uuid = $1`, uuid).Scan(&assignee, &team, &handoff, &source)
		if err != nil {
			t.Fatal(err)
		}
		if assignee != wantAssignee || team != teamID || handoff != wantHandoff || source != "chat" {
			t.Fatalf("assignment = (%d, %d, %q, %q), want (%d, %d, %q, %q)", assignee, team, handoff, source, wantAssignee, teamID, wantHandoff, "chat")
		}
	}

	t.Run("automatic AI stays out after a transfer to the same team", func(t *testing.T) {
		uuid := newConversation(t, nil)
		assign(t, uuid, assistantUserID, true, false, 1)

		var assignedTeamID int
		err := m.q.HandoffConversationToHuman.QueryRow(uuid, assistantUserID, teamID).Scan(&assignedTeamID)
		if err != nil || assignedTeamID != teamID {
			t.Fatalf("handoff team = %d, error %v, want %d", assignedTeamID, err, teamID)
		}

		action := amodels.RuleAction{Type: amodels.ActionAssignUser, Value: []string{strconv.Itoa(assistantUserID)}}
		if err := m.ApplyAction(action, models.Conversation{UUID: uuid}, umodels.User{}); err != nil {
			t.Fatal(err)
		}
		checkAssignment(t, uuid, 0, "true")
		assign(t, uuid, humanID, false, false, 1)
		assign(t, uuid, assistantUserID, true, false, 0)
		checkAssignment(t, uuid, humanID, "true")
		assign(t, uuid, assistantUserID, false, true, 1)
		checkAssignment(t, uuid, assistantUserID, "false")
	})

	t.Run("earlier handoff events are respected until a manual AI assignment", func(t *testing.T) {
		uuid := newConversation(t, humanID)
		_, err := db.Exec(`INSERT INTO ai_agent_events (assistant_id, conversation_id, type)
			SELECT $1, id, 'handoff' FROM conversations WHERE uuid = $2`, assistantID, uuid)
		if err != nil {
			t.Fatal(err)
		}
		assign(t, uuid, assistantUserID, true, false, 0)
		checkAssignment(t, uuid, humanID, "")
		assign(t, uuid, assistantUserID, false, true, 1)
		assign(t, uuid, humanID, false, false, 1)
		assign(t, uuid, assistantUserID, true, false, 1)
		checkAssignment(t, uuid, assistantUserID, "false")
	})

	t.Run("a late handoff cannot unassign a human who has taken over", func(t *testing.T) {
		uuid := newConversation(t, assistantUserID)
		assign(t, uuid, humanID, false, false, 1)

		var assignedTeamID int
		err := m.q.HandoffConversationToHuman.QueryRow(uuid, assistantUserID, teamID).Scan(&assignedTeamID)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("stale handoff returned %v, want %v", err, sql.ErrNoRows)
		}
		checkAssignment(t, uuid, humanID, "")
	})
}
