package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/abhinavxd/libredesk/internal/conversation"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	imodels "github.com/abhinavxd/libredesk/internal/inbox/models"
	"github.com/abhinavxd/libredesk/internal/testutil"
	"github.com/abhinavxd/libredesk/internal/user"
	"github.com/golang-jwt/jwt/v5"
	"github.com/valyala/fasthttp"
	"github.com/volatiletech/null/v9"
	"github.com/zerodha/fastglue"
)

func testSupportIdentity(inbox imodels.Inbox, now time.Time) Claims {
	return Claims{
		Purpose: supportSyncPurpose, ExternalUserID: supportSyncPrefix + inbox.UUID + ":" + strings.Repeat("a", 64),
		Email: "alice@example.test", FirstName: "Alice", ContactCustomAttributes: map[string]any{"xboard_plan": "Basic"},
		RegisteredClaims: jwt.RegisteredClaims{
			Audience: jwt.ClaimStrings{inbox.UUID}, IssuedAt: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
		},
	}
}

func TestWidgetPendingIdentityScope(t *testing.T) {
	inbox := imodels.Inbox{UUID: "8791160e-39c2-4fcf-b4b6-80a882c6c628", Secret: null.StringFrom("test-inbox-secret")}
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	claims := testSupportIdentity(inbox, now)
	token, err := sealWidgetPendingIdentity(inbox, claims, 24*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(token, claims.Email) || strings.Contains(token, claims.FirstName) {
		t.Fatal("pending identity exposed profile data")
	}
	got, err := openWidgetPendingIdentity(inbox, token, now.Add(time.Hour))
	if err != nil || got.ExternalUserID != claims.ExternalUserID || got.Email != claims.Email {
		t.Fatalf("valid scoped capability rejected: %v", err)
	}
	if _, err := verifyWidgetIdentityJWT(token, inbox.Secret.String, inbox.UUID); err == nil {
		t.Fatal("pending capability can be exchanged for an ordinary widget session")
	}
	other := inbox
	other.UUID = "9d339fd7-564b-4ab1-8edd-396b4e1639a5"
	rotated := inbox
	rotated.Secret = null.StringFrom("rotated-inbox-secret")
	tampered := token[:len(pendingIdentityPrefix)+4] + "!" + token[len(pendingIdentityPrefix)+5:]
	for _, tc := range []struct {
		name  string
		inbox imodels.Inbox
		token string
		now   time.Time
	}{
		{"expired", inbox, token, now.Add(maxPendingIdentityTTL)},
		{"other inbox", other, token, now},
		{"rotated secret", rotated, token, now},
		{"tampered", inbox, tampered, now},
		{"plaintext", inbox, pendingIdentityPrefix + `{"claims":{}}`, now},
		{"oversized", inbox, token + strings.Repeat("a", maxPendingIdentityBytes), now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := openWidgetPendingIdentity(tc.inbox, tc.token, tc.now); err == nil {
				t.Fatal("invalid pending capability accepted")
			}
		})
	}
}

func TestWidgetSupportSyncDefersProfileUntilFirstMessage(t *testing.T) {
	db := testutil.NewDB(t, "widget_support_pending")
	app := newWidgetSessionTestApp(t)
	app.i18n = testutil.NewI18n(t)
	var err error
	app.user, err = user.New(app.i18n, user.Opts{DB: db, Lo: app.lo})
	if err != nil {
		t.Fatal(err)
	}
	app.conversation, err = conversation.New(nil, app.i18n, nil, nil, nil, nil, app.user, nil, nil, nil, nil,
		nil, nil, nil, nil, conversation.Opts{DB: db, Lo: app.lo})
	if err != nil {
		t.Fatal(err)
	}
	inbox := imodels.Inbox{Secret: null.StringFrom("test-inbox-secret"),
		Config: []byte(`{"users":{"allow_start_conversation":true}}`)}
	if err := db.QueryRow(`INSERT INTO inboxes (name, channel, "from") VALUES ('Support test', 'livechat', '') RETURNING id, uuid`).
		Scan(&inbox.ID, &inbox.UUID); err != nil {
		t.Fatal(err)
	}
	config := livechat.Config{Users: livechat.AudienceConfig{AllowStartConversation: true}}
	claims := testSupportIdentity(inbox, time.Now())
	jwtToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(inbox.Secret.String))
	if err != nil {
		t.Fatal(err)
	}
	exchange := func() (*fastglue.Request, string, string) {
		t.Helper()
		r := visitorProfileRequest(app, `{"jwt":"`+jwtToken+`"}`)
		r.RequestCtx.Request.SetRequestURI("/api/v1/widget/chat/auth/exchange")
		r.RequestCtx.SetUserValue(ctxWidgetInbox, inbox)
		r.RequestCtx.SetUserValue(ctxWidgetConfig, config)
		if err := handleAuthExchange(r); err != nil {
			t.Fatal(err)
		}
		if got := r.RequestCtx.Response.StatusCode(); got != fasthttp.StatusOK {
			t.Fatalf("status = %d, body = %s", got, r.RequestCtx.Response.Body())
		}
		var reply struct {
			Data struct {
				Pending string `json:"pending_identity"`
				Session string `json:"session_token"`
			} `json:"data"`
		}
		if err := json.Unmarshal(r.RequestCtx.Response.Body(), &reply); err != nil {
			t.Fatal(err)
		}
		return r, reply.Data.Pending, reply.Data.Session
	}
	r, pending, session := exchange()
	if pending == "" || session != "" || string(r.RequestCtx.Response.Header.Peek("Cache-Control")) != "no-store" {
		t.Fatal("passive login did not return a private pending identity")
	}
	var count int
	if err := db.Get(&count, `SELECT COUNT(*) FROM users WHERE external_user_id = $1 OR email = $2`, claims.ExternalUserID, claims.Email); err != nil || count != 0 {
		t.Fatalf("passive login wrote user data: count=%d err=%v", count, err)
	}
	if got := app.redis.DBSize(context.Background()).Val(); got != 0 {
		t.Fatalf("passive login persisted Redis state: %d keys", got)
	}
	contact, realToken, err := prepareWidgetPendingContact(r, inbox, config, claims)
	if err != nil {
		t.Fatal(err)
	}
	checkEmail := func(want string) {
		t.Helper()
		var email string
		err := db.Get(&email, `SELECT COALESCE(email,'') FROM users WHERE id = $1`, contact.ID)
		if err != nil || email != want {
			t.Fatalf("email=%q err=%v want=%q", email, err, want)
		}
	}
	checkEmail("")
	if _, pending, existingSession := exchange(); pending == "" || existingSession != "" {
		t.Fatal("contact without a message received a full session")
	}
	checkEmail("")
	var conversationID int
	if err := db.Get(&conversationID, `INSERT INTO conversations (contact_id,inbox_id,status_id)
		VALUES ($1,$2,(SELECT id FROM conversation_statuses WHERE name = 'Open')) RETURNING id`, contact.ID, inbox.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_messages (conversation_id,type,status,sender_id,sender_type,content)
		VALUES ($1,'incoming','received',$2,'contact','Hello')`, conversationID, contact.ID); err != nil {
		t.Fatal(err)
	}
	saveWidgetPendingProfile(app, inbox, contact.ID, realToken, claims)
	checkEmail(claims.Email)
	if _, pending, existingSession := exchange(); pending != "" || existingSession != realToken {
		t.Fatal("returning account did not reuse its existing session")
	}
}
