package macro

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/abhinavxd/libredesk/internal/macro/models"
	"github.com/abhinavxd/libredesk/internal/testutil"
	"github.com/jmoiron/sqlx"
	"github.com/zerodha/logf"
)

func newTestManager(t *testing.T) (*Manager, *sqlx.DB) {
	t.Helper()
	db := testutil.NewDB(t, "macro")
	lo := logf.New(logf.Opts{})
	mgr, err := New(Opts{DB: db, Lo: &lo, I18n: testutil.NewI18n(t)})
	if err != nil {
		t.Fatalf("creating macro manager: %v", err)
	}
	return mgr, db
}

func TestGetAllCompact(t *testing.T) {
	mgr, _ := newTestManager(t)

	withContent := mustCreate(t, mgr, "with content", "<p>hello</p>", "all", nil, nil, []string{"replying"})
	withoutContent, err := mgr.Create("without content", "", nil, nil, "all", []string{"replying"}, json.RawMessage(`[{"type":"add_tags","value":["x"]}]`))
	if err != nil {
		t.Fatalf("creating macro: %v", err)
	}

	full, err := mgr.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if len(full) != 2 {
		t.Fatalf("GetAll returned %d macros, want 2", len(full))
	}

	compact, err := mgr.GetAllCompact("", 1, 30)
	if err != nil {
		t.Fatalf("GetAllCompact: %v", err)
	}
	if len(compact) != 2 {
		t.Fatalf("GetAllCompact returned %d macros, want 2", len(compact))
	}
	for _, m := range compact {
		if m.Total != 2 {
			t.Errorf("macro %d has total %d, want 2", m.ID, m.Total)
		}
		switch m.ID {
		case withContent.ID:
			if !m.HasMessageContent {
				t.Error("macro with content has HasMessageContent=false")
			}
		case withoutContent.ID:
			if m.HasMessageContent {
				t.Error("macro without content has HasMessageContent=true")
			}
			if len(m.Actions) == 0 {
				t.Error("compact row lost actions")
			}
		default:
			t.Errorf("unexpected macro id %d", m.ID)
		}
	}

	filtered, err := mgr.GetAllCompact("without", 1, 30)
	if err != nil {
		t.Fatalf("GetAllCompact with query: %v", err)
	}
	if len(filtered) != 1 || filtered[0].ID != withoutContent.ID {
		t.Fatalf("name filter returned %d macros, want the one named 'without content'", len(filtered))
	}

	paged, err := mgr.GetAllCompact("", 2, 1)
	if err != nil {
		t.Fatalf("GetAllCompact page 2: %v", err)
	}
	if len(paged) != 1 {
		t.Fatalf("page 2 of size 1 returned %d macros, want 1", len(paged))
	}
	if paged[0].Total != 2 {
		t.Fatalf("page 2 of size 1 has total %d, want 2", paged[0].Total)
	}

	got, err := mgr.Get(withContent.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.MessageContent != "<p>hello</p>" {
		t.Errorf("Get returned message content %q", got.MessageContent)
	}
}

func TestSearchCompact(t *testing.T) {
	mgr, db := newTestManager(t)

	var agentID, otherID, teamID, otherTeamID int
	if err := db.Get(&agentID, `INSERT INTO users (type, email, first_name) VALUES ('agent', 'a@example.com', 'A') RETURNING id`); err != nil {
		t.Fatalf("inserting agent: %v", err)
	}
	if err := db.Get(&otherID, `INSERT INTO users (type, email, first_name) VALUES ('agent', 'b@example.com', 'B') RETURNING id`); err != nil {
		t.Fatalf("inserting agent: %v", err)
	}
	if err := db.Get(&teamID, `INSERT INTO teams (name, timezone, conversation_assignment_type) VALUES ('mine', 'UTC', 'Manual') RETURNING id`); err != nil {
		t.Fatalf("inserting team: %v", err)
	}
	if err := db.Get(&otherTeamID, `INSERT INTO teams (name, timezone, conversation_assignment_type) VALUES ('theirs', 'UTC', 'Manual') RETURNING id`); err != nil {
		t.Fatalf("inserting team: %v", err)
	}

	everyone := mustCreate(t, mgr, "everyone", "<p>x</p>", "all", nil, nil, []string{"replying"})
	mine := mustCreate(t, mgr, "mine only", "<p>x</p>", "user", &agentID, nil, []string{"replying"})
	mustCreate(t, mgr, "theirs only", "<p>x</p>", "user", &otherID, nil, []string{"replying"})
	myTeam := mustCreate(t, mgr, "my team", "<p>x</p>", "team", nil, &teamID, []string{"replying"})
	mustCreate(t, mgr, "other team", "<p>x</p>", "team", nil, &otherTeamID, []string{"replying"})
	noteOnly := mustCreate(t, mgr, "note only", "<p>x</p>", "all", nil, nil, []string{"adding_private_note"})

	visible, err := mgr.SearchCompact("", "", agentID, []int{teamID}, false)
	if err != nil {
		t.Fatalf("SearchCompact: %v", err)
	}
	want := map[int]bool{everyone.ID: true, mine.ID: true, myTeam.ID: true, noteOnly.ID: true}
	if len(visible) != len(want) {
		t.Fatalf("got %d macros, want %d", len(visible), len(want))
	}
	for _, m := range visible {
		if !want[m.ID] {
			t.Errorf("macro %q leaked past visibility scoping", m.Name)
		}
	}

	replying, err := mgr.SearchCompact("", "replying", agentID, []int{teamID}, false)
	if err != nil {
		t.Fatalf("SearchCompact with view: %v", err)
	}
	for _, m := range replying {
		if m.ID == noteOnly.ID {
			t.Error("view filter returned a macro not visible while replying")
		}
	}
	if len(replying) != 3 {
		t.Fatalf("got %d macros for the replying view, want 3", len(replying))
	}

	byName, err := mgr.SearchCompact("TEAM", "", agentID, []int{teamID}, false)
	if err != nil {
		t.Fatalf("SearchCompact with query: %v", err)
	}
	if len(byName) != 1 || byName[0].ID != myTeam.ID {
		t.Fatalf("case-insensitive name search returned %d macros, want just 'my team'", len(byName))
	}

	noTeams, err := mgr.SearchCompact("", "", agentID, []int{}, false)
	if err != nil {
		t.Fatalf("SearchCompact with no teams: %v", err)
	}
	for _, m := range noTeams {
		if m.ID == myTeam.ID {
			t.Error("team macro returned for an agent with no teams")
		}
	}

	t.Run("message-only results include all eligible macros", func(t *testing.T) {
		if _, err := mgr.Create("action only", "", nil, nil, "all", []string{"replying"}, json.RawMessage(`[{"type":"add_tags","value":["x"]}]`)); err != nil {
			t.Fatalf("creating action-only macro: %v", err)
		}
		want := map[int]bool{everyone.ID: true, mine.ID: true, myTeam.ID: true}
		for i := range 30 {
			m := mustCreate(t, mgr, fmt.Sprintf("reply %d", i), "<p>x</p>", "all", nil, nil, []string{"replying"})
			want[m.ID] = true
		}

		limited, err := mgr.SearchCompact("", "replying", agentID, []int{teamID}, false)
		if err != nil || len(limited) != 30 {
			t.Fatalf("default search returned %d macros, want 30, error: %v", len(limited), err)
		}
		actions, err := mgr.SearchCompact("action only", "replying", agentID, []int{teamID}, false)
		if err != nil || len(actions) != 1 || actions[0].HasMessageContent {
			t.Fatalf("default search returned %v, want an action-only macro, error: %v", actions, err)
		}

		messages, err := mgr.SearchCompact("", "replying", agentID, []int{teamID}, true)
		if err != nil || len(messages) != len(want) {
			t.Fatalf("message-only search returned %d macros, want %d, error: %v", len(messages), len(want), err)
		}
		for _, m := range messages {
			if !want[m.ID] || !m.HasMessageContent {
				t.Errorf("unexpected macro %q in message-only results", m.Name)
			}
		}
	})
}

func TestMacroOrder(t *testing.T) {
	mgr, db := newTestManager(t)
	var owner, other int
	if err := db.Get(&owner, `INSERT INTO users (type, email, first_name) VALUES ('agent', 'owner@example.com', 'Owner') RETURNING id`); err != nil {
		t.Fatal(err)
	}
	if err := db.Get(&other, `INSERT INTO users (type, email, first_name) VALUES ('agent', 'other@example.com', 'Other') RETURNING id`); err != nil {
		t.Fatal(err)
	}
	first := mustCreate(t, mgr, "reply first", "<p>First</p>", "all", nil, nil, []string{"replying"})
	second := mustCreate(t, mgr, "reply second", "<p>Second</p>", "all", nil, nil, []string{"replying"})
	private := mustCreate(t, mgr, "reply private", "<p>Private</p>", "user", &other, nil, []string{"replying"})
	note := mustCreate(t, mgr, "reply notes", "<p>Note</p>", "all", nil, nil, []string{"adding_private_note"})
	deleted := mustCreate(t, mgr, "deleted", "<p>Deleted</p>", "all", nil, nil, []string{"replying"})
	if err := mgr.Delete(deleted.ID); err != nil {
		t.Fatal(err)
	}
	if err := mgr.SetOrder([]int{private.ID, note.ID, first.ID, deleted.ID, second.ID}); err != nil {
		t.Fatal(err)
	}
	newest := mustCreate(t, mgr, "reply new", "<p>New</p>", "all", nil, nil, []string{"replying"})

	// A fresh manager sees the order saved in the database.
	fresh, err := New(Opts{DB: db, Lo: mgr.lo, I18n: mgr.i18n})
	if err != nil {
		t.Fatal(err)
	}
	checkOrder := func(macros []models.MacroCompact, err error, want ...int) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]int, 0, len(macros))
		for _, macro := range macros {
			ids = append(ids, macro.ID)
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("order %v, want %v", ids, want)
		}
	}
	admin, err := fresh.GetAllCompact("", 1, 0)
	checkOrder(admin, err, private.ID, note.ID, first.ID, second.ID, newest.ID)
	page, err := fresh.GetAllCompact("reply", 2, 2)
	checkOrder(page, err, first.ID, second.ID)
	quick, err := fresh.SearchCompact("", "replying", owner, nil, true)
	checkOrder(quick, err, first.ID, second.ID, newest.ID)
	quick, err = fresh.SearchCompact("", "replying", other, nil, true)
	checkOrder(quick, err, private.ID, first.ID, second.ID, newest.ID)

	if err := fresh.IncrementUsageCount(second.ID); err != nil {
		t.Fatal(err)
	}
	shortcuts, err := fresh.SearchCompact("", "replying", owner, nil, false)
	checkOrder(shortcuts, err, second.ID, newest.ID, first.ID)
	quick, err = fresh.SearchCompact("", "replying", owner, nil, true)
	checkOrder(quick, err, first.ID, second.ID, newest.ID)
	for _, bad := range [][]int{nil, {0}, {first.ID, first.ID}} {
		if err := fresh.SetOrder(bad); err == nil {
			t.Fatalf("order %v was accepted", bad)
		}
	}
	var stored []byte
	if err := db.Get(&stored, `SELECT value FROM settings WHERE key = 'macros.order'`); err != nil {
		t.Fatal(err)
	}
	var ids []int
	if err := json.Unmarshal(stored, &ids); err != nil || !slices.Equal(ids, []int{private.ID, note.ID, first.ID, second.ID}) {
		t.Fatalf("stored order %s, error %v", stored, err)
	}
	macro, err := fresh.Get(first.ID)
	if err != nil || !macro.UpdatedAt.Equal(first.UpdatedAt) || macro.MessageContent != first.MessageContent {
		t.Fatalf("reordering changed the macro: %v, error %v", macro, err)
	}
	if err := fresh.SetOrder([]int{}); err != nil {
		t.Fatal(err)
	}
	admin, err = fresh.GetAllCompact("", 1, 0)
	checkOrder(admin, err, newest.ID, note.ID, private.ID, second.ID, first.ID)
	quick, err = fresh.SearchCompact("", "replying", owner, nil, true)
	checkOrder(quick, err, newest.ID, second.ID, first.ID)
}

func mustCreate(t *testing.T, mgr *Manager, name, content, visibility string, userID, teamID *int, visibleWhen []string) models.Macro {
	t.Helper()
	m, err := mgr.Create(name, content, userID, teamID, visibility, visibleWhen, json.RawMessage(`[]`))
	if err != nil {
		t.Fatalf("creating macro %q: %v", name, err)
	}
	return m
}
