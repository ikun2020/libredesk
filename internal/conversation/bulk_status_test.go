package conversation

import (
	"fmt"
	"testing"
	"time"

	authzmodels "github.com/abhinavxd/libredesk/internal/authz/models"
	"github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/dbutil"
	"github.com/abhinavxd/libredesk/internal/testutil"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/zerodha/logf"
)

func TestBulkOpenConversationCandidatesAndGuard(t *testing.T) {
	db := testutil.NewDB(t, "bulk_open_status")
	logger := logf.New(logf.Opts{})
	m := &Manager{db: db, lo: &logger, settingsStore: stubSettingsStore{}, i18n: testutil.NewI18n(t)}
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
	actor := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('agent', 'Agent', '') RETURNING id")
	other := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('agent', 'Other', '') RETURNING id")
	contact := insertID("INSERT INTO users (type, first_name, last_name) VALUES ('contact', 'Visitor', '') RETURNING id")
	inbox := insertID("INSERT INTO inboxes (name, channel) VALUES ('Chat', 'livechat') RETURNING id")
	otherInbox := insertID("INSERT INTO inboxes (name, channel) VALUES ('Other', 'livechat') RETURNING id")
	insert := func(assignee, inboxID int, status string, count int) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO conversations (contact_id, inbox_id, status_id, assigned_user_id)
			SELECT $1, $2, (SELECT id FROM conversation_statuses WHERE name = $3), $4 FROM generate_series(1, $5)`,
			contact, inboxID, status, assignee, count); err != nil {
			t.Fatal(err)
		}
	}
	insert(actor, inbox, models.StatusOpen, conversationsListMaxPageSize+1)
	insert(actor, otherInbox, models.StatusOpen, 1)
	insert(other, inbox, models.StatusOpen, 1)
	insert(actor, inbox, models.StatusResolved, 1)
	insert(actor, inbox, models.StatusClosed, 1)
	insert(actor, inbox, models.StatusSnoozed, 1)

	user := umodels.User{ID: actor, Permissions: []string{
		authzmodels.PermConversationsRead, authzmodels.PermConversationsReadAssigned,
	}}
	filters := fmt.Sprintf(`[{"model":"conversations","field":"inbox_id","operator":"equals","value":"%d"}]`, inbox)
	// A broad candidate query must still apply the caller's individual conversation ACL.
	matches, err := m.GetBulkOpenConversations(user, nil, []string{models.AllConversations}, filters)
	if err != nil {
		t.Fatal(err)
	}
	if want := conversationsListMaxPageSize + 1; len(matches) != want {
		t.Fatalf("candidate count = %d, want %d", len(matches), want)
	}

	target := matches[0]
	if _, err := db.Exec("UPDATE conversations SET updated_at = updated_at + INTERVAL '1 second' WHERE uuid = $1", target.UUID); err != nil {
		t.Fatal(err)
	}
	update := func(candidate BulkOpenConversation, status string, want int64) {
		t.Helper()
		res, err := m.q.UpdateConversationStatus.Exec(candidate.UUID, status, time.Time{}, candidate.UpdatedAt,
			candidate.AssignedUserID, candidate.AssignedTeamID)
		if err != nil {
			t.Fatal(err)
		}
		if rows, err := res.RowsAffected(); err != nil || rows != want {
			t.Fatalf("affected = %d, err = %v, want %d", rows, err, want)
		}
	}
	update(target, models.StatusClosed, 0)
	update(matches[1], models.StatusResolved, 1)
	var resolved BulkOpenConversation
	if err := db.Get(&resolved, `SELECT uuid, updated_at, assigned_user_id, assigned_team_id FROM conversations WHERE uuid = $1`, matches[1].UUID); err != nil {
		t.Fatal(err)
	}
	update(resolved, models.StatusClosed, 0)
}
