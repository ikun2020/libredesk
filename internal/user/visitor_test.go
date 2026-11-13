package user

import (
	"encoding/json"
	"testing"
)

func TestUpdateVisitorProfileSQLIdentityBoundary(t *testing.T) {
	mgr, db := newTestManager(t)
	for _, tc := range []struct {
		name, typ, guard string
		want             bool
	}{
		{"visitor", "visitor", "", true},
		{"contact", "contact", "", false},
		{"agent", "agent", "", false},
		{"disabled", "visitor", "enabled=false", false},
		{"deleted", "visitor", "deleted_at=now()", false},
		{"external identity", "visitor", "external_user_id='verified-id'", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var id int
			if err := db.Get(&id, `INSERT INTO users(type,email,first_name,custom_attributes) VALUES($1,$2,'Visitor','{"staff_note":"keep"}') RETURNING id`, tc.typ, tc.name+"@example.com"); err != nil {
				t.Fatal(err)
			}
			if tc.guard != "" {
				db.MustExec(`UPDATE users SET `+tc.guard+` WHERE id=$1`, id)
			}
			updated, err := mgr.UpdateVisitorProfile(id, "same@example.com", map[string]string{"xboard_balance": "2.50"})
			if err != nil || updated != tc.want {
				t.Fatalf("updated=%v err=%v", updated, err)
			}
			var email string
			var raw []byte
			if err := db.QueryRow(`SELECT email,custom_attributes FROM users WHERE id=$1`, id).Scan(&email, &raw); err != nil {
				t.Fatal(err)
			}
			var attrs map[string]string
			if err := json.Unmarshal(raw, &attrs); err != nil {
				t.Fatal(err)
			}
			if tc.want {
				if email != "same@example.com" || attrs["xboard_balance"] != "2.50" || attrs["staff_note"] != "keep" {
					t.Fatalf("wrong update: %s %s", email, raw)
				}
			} else if email != tc.name+"@example.com" || len(attrs) != 1 {
				t.Fatalf("protected row modified: %s %s", email, raw)
			}
		})
	}
	if updated, err := mgr.UpdateVisitorProfile(999999, "missing@example.com", nil); err != nil || updated {
		t.Fatalf("missing visitor update=%v err=%v", updated, err)
	}
}
