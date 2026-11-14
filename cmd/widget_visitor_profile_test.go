package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/abhinavxd/libredesk/internal/inbox"
	"github.com/abhinavxd/libredesk/internal/testutil"
	"github.com/abhinavxd/libredesk/internal/user"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

const validVisitorProfileJSON = `{"email":"Alice@EXAMPLE.COM","contact_custom_attributes":{"xboard_used_traffic":"1.00 GB","xboard_expires_at":"2026-12-01 00:00:00","xboard_balance":"2.50","xboard_total_traffic":"10.00 GB","xboard_plan":"标准套餐"}}`

func TestVisitorProfileDecoding(t *testing.T) {
	var profile visitorProfile
	if err := json.Unmarshal([]byte(validVisitorProfileJSON), &profile); err != nil {
		t.Fatal(err)
	}
	if profile.Email != "alice@example.com" || len(profile.ContactCustomAttributes) != 5 || profile.ContactCustomAttributes["xboard_plan"] != "标准套餐" {
		t.Fatalf("incorrect profile: %+v", profile)
	}
	validBoundary := `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":"` + strings.Repeat("界", 85) + `a"}}`
	if err := json.Unmarshal([]byte(validBoundary), &profile); err != nil {
		t.Fatalf("256-byte UTF-8 string rejected: %v", err)
	}
	for name, raw := range map[string]string{
		"missing email":       `{}`,
		"null profile":        `null`,
		"invalid email":       `{"email":"not-an-email"}`,
		"display name email":  `{"email":"Alice <alice@example.com>"}`,
		"null email":          `{"email":null}`,
		"object email":        `{"email":{"address":"a@example.com"}}`,
		"control email":       `{"email":"a@example.com\n"}`,
		"long email":          `{"email":"` + strings.Repeat("a", 255) + `@example.com"}`,
		"contact selector":    `{"email":"a@example.com","user_id":42}`,
		"external selector":   `{"email":"a@example.com","external_user_id":"xboard:1"}`,
		"unknown top level":   `{"email":"a@example.com","first_name":"Admin"}`,
		"wrong key casing":    `{"Email":"a@example.com"}`,
		"arbitrary attribute": `{"email":"a@example.com","contact_custom_attributes":{"role":"admin"}}`,
		"null attributes":     `{"email":"a@example.com","contact_custom_attributes":null}`,
		"null value":          `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":null}}`,
		"number value":        `{"email":"a@example.com","contact_custom_attributes":{"xboard_balance":100}}`,
		"object value":        `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":{}}}`,
		"array value":         `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":[]}}`,
		"long value":          `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":"` + strings.Repeat("a", 257) + `"}}`,
		"control value":       `{"email":"a@example.com","contact_custom_attributes":{"xboard_plan":"a\u0000b"}}`,
		"oversized profile":   `{` + strings.Repeat(" ", maxVisitorProfileBytes) + `"email":"a@example.com"}`,
		"trailing object":     `{"email":"a@example.com"}{}`,
		"invalid UTF-8":       "{\"email\":\"a@example.com\",\"contact_custom_attributes\":{\"xboard_plan\":\"\xff\"}}",
	} {
		t.Run(name, func(t *testing.T) {
			if err := json.Unmarshal([]byte(raw), &profile); err == nil {
				t.Fatal("untrusted profile accepted")
			}
		})
	}
}

func visitorProfileRequest(app *App, body string) *fastglue.Request {
	ctx := &fasthttp.RequestCtx{}
	ctx.Init(&fasthttp.Request{}, nil, nil)
	ctx.Request.Header.SetMethod("POST")
	ctx.Request.Header.SetContentType("application/json")
	ctx.Request.SetRequestURI("/api/v1/widget/chat/visitor/profile")
	ctx.Request.SetBodyString(body)
	return &fastglue.Request{RequestCtx: ctx, Context: app}
}

func TestVisitorProfileDoesNotCreateSessionOrChat(t *testing.T) {
	app := newValidatorTestApp(t) // No DB, Redis or conversation manager: any creation would fail.
	for _, withContact := range []bool{false, true} {
		r := visitorProfileRequest(app, validVisitorProfileJSON)
		if withContact {
			r.RequestCtx.SetUserValue(ctxWidgetContactID, 42)
			r.RequestCtx.SetUserValue(ctxWidgetIsVisitor, false)
		}
		if err := handleWidgetVisitorProfile(r); err != nil {
			t.Fatal(err)
		}
		if r.RequestCtx.Response.StatusCode() != fasthttp.StatusForbidden {
			t.Fatalf("profile request without a visitor accepted: %s", r.RequestCtx.Response.Body())
		}
	}
	r := visitorProfileRequest(app, `{"visitor_profile":`+validVisitorProfileJSON+`}`)
	r.RequestCtx.Request.SetRequestURI("/api/v1/widget/chat/conversations/init")
	if err := handleChatInit(r); err != nil {
		t.Fatal(err)
	}
	if r.RequestCtx.Response.StatusCode() != fasthttp.StatusBadRequest {
		t.Fatal("profile-only init accepted without a real message or attachment")
	}
}

func TestWidgetVisitorProfileAuthorizationAndPersistence(t *testing.T) {
	db := testutil.NewDB(t, "widget_visitor_profile")
	app := newSecureWidgetTestApp(t)
	app.i18n = testutil.NewI18n(t)
	var err error
	app.user, err = user.New(app.i18n, user.Opts{DB: db, Lo: app.lo})
	if err != nil {
		t.Fatal(err)
	}
	app.inbox, err = inbox.New(app.lo, db, app.i18n, "")
	if err != nil {
		t.Fatal(err)
	}
	var inboxID, otherInboxID int
	var inboxUUID, otherInboxUUID string
	// Normal inbox creation supplies an empty From for livechat. Omitting it
	// leaves SQL NULL, which cannot be scanned into the Inbox.From string.
	if err := db.QueryRow(`INSERT INTO inboxes (name, channel, "from") VALUES ('Visitor Profile', 'livechat', '') RETURNING id, uuid`).Scan(&inboxID, &inboxUUID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`INSERT INTO inboxes (name, channel, "from") VALUES ('Other Inbox', 'livechat', '') RETURNING id, uuid`).Scan(&otherInboxID, &otherInboxUUID); err != nil {
		t.Fatal(err)
	}
	for _, uuid := range []string{inboxUUID, otherInboxUUID} {
		if _, err := app.inbox.GetDBRecord(uuid); err != nil {
			t.Fatalf("invalid livechat inbox fixture: %v", err)
		}
	}
	insert := func(typ, email string) int {
		var id int
		if err := db.Get(&id, `INSERT INTO users (type, email, first_name, custom_attributes) VALUES ($1, $2, 'Existing', '{"staff_note":"preserve"}') RETURNING id`, typ, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	visitorID := insert("visitor", "old@example.com")
	contactID := insert("contact", "alice@example.com")
	otherVisitorID := insert("visitor", "alice@example.com")
	staleID := insert("contact", "stale@example.com")
	token := func(id int, visitor bool) string {
		token, err := generateSessionToken(app, id, inboxID, visitor, "", defaultSessionTTL)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	visitorToken := token(visitorID, true)
	for _, tc := range []struct {
		name, token, inbox string
		want               int
	}{
		{"missing token", "", inboxUUID, fasthttp.StatusUnauthorized},
		{"unknown token", "not-a-session", inboxUUID, fasthttp.StatusUnauthorized},
		{"wrong inbox", visitorToken, otherInboxUUID, fasthttp.StatusUnauthorized},
		{"verified contact", token(contactID, false), inboxUUID, fasthttp.StatusForbidden},
		{"stale visitor flag", token(staleID, true), inboxUUID, fasthttp.StatusForbidden},
		{"current visitor", visitorToken, inboxUUID, fasthttp.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := visitorProfileRequest(app, validVisitorProfileJSON)
			r.RequestCtx.Request.Header.Set(hdrWidgetInboxID, tc.inbox)
			if tc.token != "" {
				r.RequestCtx.Request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			if err := widgetAuth(handleWidgetVisitorProfile)(r); err != nil {
				t.Fatal(err)
			}
			if r.RequestCtx.Response.StatusCode() != tc.want {
				t.Fatalf("status=%d body=%s", r.RequestCtx.Response.StatusCode(), r.RequestCtx.Response.Body())
			}
		})
	}
	var email string
	var attrsRaw []byte
	if err := db.QueryRow(`SELECT email, custom_attributes FROM users WHERE id=$1`, visitorID).Scan(&email, &attrsRaw); err != nil {
		t.Fatal(err)
	}
	var attrs map[string]string
	if err := json.Unmarshal(attrsRaw, &attrs); err != nil {
		t.Fatal(err)
	}
	if email != "alice@example.com" || attrs["xboard_plan"] != "标准套餐" || attrs["staff_note"] != "preserve" {
		t.Fatalf("wrong saved profile: %s %s", email, attrsRaw)
	}
	for _, id := range []int{contactID, otherVisitorID, staleID} {
		if err := db.Get(&attrsRaw, `SELECT custom_attributes FROM users WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(attrsRaw), "xboard_") {
			t.Fatalf("another identity modified: %d", id)
		}
	}
	for table, want := range map[string]int{"users": 4, "conversations": 0, "conversation_messages": 0} {
		var count int
		if err := db.Get(&count, `SELECT COUNT(*) FROM `+table); err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("%s count=%d want=%d", table, count, want)
		}
	}
}
