package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	imodels "github.com/abhinavxd/libredesk/internal/inbox/models"
	"github.com/alicebob/miniredis/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/valyala/fasthttp"
	"github.com/volatiletech/null/v9"
	"github.com/zerodha/fastglue"
	"github.com/zerodha/logf"
)

func newSecureWidgetTestApp(t *testing.T) *App {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { client.Close() })
	lo := logf.New(logf.Opts{})
	return &App{redis: client, lo: &lo}
}

func secureTestClaims(purpose, sid string) Claims {
	now := time.Now().Truncate(time.Second)
	return Claims{Purpose: purpose, SessionID: strings.Repeat(sid, 64), ExternalUserID: "xboard:123", RegisteredClaims: jwt.RegisteredClaims{
		IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
	}}
}

func TestSecureWidgetClaimsRejectWrongPurposeAndLifetime(t *testing.T) {
	now := time.Now()
	for _, purpose := range []string{"", "logout", "revoke_legacy", "other"} {
		if err := validateSecureWidgetClaims(secureTestClaims(purpose, "a"), "login", now); err == nil {
			t.Fatalf("login accepted purpose %q", purpose)
		}
	}
	for _, mutate := range []func(*Claims){
		func(c *Claims) { c.SessionID = "a" },
		func(c *Claims) { c.SessionID = strings.Repeat("g", 64) },
		func(c *Claims) { c.SessionID = strings.Repeat("A", 64) },
		func(c *Claims) { c.ExternalUserID = "" },
		func(c *Claims) { c.IssuedAt = nil },
		func(c *Claims) { c.ExpiresAt = nil },
		func(c *Claims) { c.ExpiresAt = jwt.NewNumericDate(now.Add(6 * time.Minute)) },
		func(c *Claims) { c.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Second)) },
		func(c *Claims) { c.IssuedAt = jwt.NewNumericDate(now.Add(time.Minute)) },
	} {
		claims := secureTestClaims("login", "a")
		mutate(&claims)
		if err := validateSecureWidgetClaims(claims, "login", now); err == nil {
			t.Fatal("malformed login capability accepted")
		}
	}
	logout := secureTestClaims("logout", "a")
	logout.ExpiresAt = jwt.NewNumericDate(logout.IssuedAt.Add(24 * time.Hour))
	if err := validateSecureWidgetClaims(logout, "logout", now); err != nil {
		t.Fatal(err)
	}
	logout.ExpiresAt = jwt.NewNumericDate(logout.IssuedAt.Add(24*time.Hour + time.Second))
	if err := validateSecureWidgetClaims(logout, "logout", now); err == nil {
		t.Fatal("overlong logout capability accepted")
	}
}

func TestSecureWidgetLeaseCannotBeExtendedByActivityOrJWTReplay(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	claims := secureTestClaims("login", "a")
	claims.IssuedAt = jwt.NewNumericDate(claims.IssuedAt.Add(-2 * time.Minute))
	claims.ExpiresAt = jwt.NewNumericDate(claims.IssuedAt.Add(5 * time.Minute))
	token, err := exchangeSecureWidgetSession(app, 123, 1, claims)
	if err != nil {
		t.Fatal(err)
	}
	key := widgetSessionPrefix + token
	wantUntil := strconv.FormatInt(claims.IssuedAt.Add(secureWidgetLease).Unix(), 10)
	for range 3 {
		if _, err := loadSession(app, token, livechat.Config{}); err != nil {
			t.Fatal(err)
		}
		if !widgetSessionActive(app, token) {
			t.Fatal("valid WS session rejected")
		}
		replayed, err := exchangeSecureWidgetSession(app, 123, 1, claims)
		if err != nil || replayed != token {
			t.Fatalf("replay changed token: %v", err)
		}
		if until := app.redis.HGet(context.Background(), key, "secure_valid_until").Val(); until != wantUntil {
			t.Fatalf("replay/activity extended lease: got %s want %s", until, wantUntil)
		}
	}
	// Lease expiry does not delete the retained token. Only a freshly signed
	// authenticated heartbeat may revive it, preserving the existing iframe.
	app.redis.HSet(context.Background(), key, "secure_valid_until", time.Now().Add(-time.Second).Unix())
	if _, err := loadSession(app, token, livechat.Config{}); err == nil || widgetSessionActive(app, token) {
		t.Fatal("expired secure lease was accepted or revived by activity")
	}
	fresh := secureTestClaims("login", "a")
	renewed, err := exchangeSecureWidgetSession(app, 123, 1, fresh)
	if err != nil || renewed != token || !widgetSessionActive(app, token) {
		t.Fatalf("fresh heartbeat did not revive same session: %v", err)
	}
}

func TestSecureWidgetRevocationBlocksReplayAndOtherSessionsRemain(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	claims := secureTestClaims("login", "a")
	token, err := exchangeSecureWidgetSession(app, 123, 1, claims)
	if err != nil {
		t.Fatal(err)
	}
	other, err := exchangeSecureWidgetSession(app, 123, 1, secureTestClaims("login", "b"))
	if err != nil {
		t.Fatal(err)
	}
	otherInbox, err := exchangeSecureWidgetSession(app, 123, 2, claims)
	if err != nil {
		t.Fatal(err)
	}
	logout := claims
	logout.Purpose = "logout"
	for range 2 {
		if err := revokeSecureWidgetSession(app, 1, logout); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := loadSession(app, token, livechat.Config{}); err == nil || widgetSessionActive(app, token) {
		t.Fatal("revoked token still authenticates HTTP/WS")
	}
	if _, err := exchangeSecureWidgetSession(app, 123, 1, claims); err == nil {
		t.Fatal("unexpired login JWT resurrected revoked session")
	}
	if !widgetSessionActive(app, other) || !widgetSessionActive(app, otherInbox) {
		t.Fatal("logout revoked a different device or inbox")
	}
	if _, err := exchangeSecureWidgetSession(app, 123, 1, logout); err == nil {
		t.Fatal("logout capability exchanged for login")
	}
}

func TestSecureWidgetConcurrentExchangeCannotUndoRevocation(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	claims := secureTestClaims("login", "a")
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = exchangeSecureWidgetSession(app, 123, 1, claims) }()
	}
	logout := claims
	logout.Purpose = "logout"
	if err := revokeSecureWidgetSession(app, 1, logout); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if _, err := exchangeSecureWidgetSession(app, 123, 1, claims); err == nil {
		t.Fatal("concurrent exchange undid logout")
	}
	if app.redis.Exists(context.Background(), secureWidgetScope(1, claims)+":token").Val() != 0 {
		t.Fatal("logout left a scoped token after concurrent exchange")
	}
}

func TestLegacyWidgetMigrationIsScopedAndIdempotent(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	legacy, err := generateSessionToken(app, 123, 1, false, "xboard:123", defaultSessionTTL)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := generateSessionToken(app, 123, 2, false, "xboard:123", defaultSessionTTL)
	visitor, _ := generateSessionToken(app, 456, 1, true, "", defaultSessionTTL)
	if err := migrateLegacyWidgetSessions(app, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSession(app, legacy, livechat.Config{}); err == nil || widgetSessionActive(app, legacy) {
		t.Fatal("migration retained old authenticated session")
	}
	fresh, err := generateSessionToken(app, 123, 1, false, "xboard:123", defaultSessionTTL)
	if err != nil {
		t.Fatal(err)
	}
	secure, err := exchangeSecureWidgetSession(app, 123, 1, secureTestClaims("login", "a"))
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyWidgetSessions(app, 1); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{other, visitor, fresh, secure} {
		if _, err := loadSession(app, token, livechat.Config{}); err != nil || !widgetSessionActive(app, token) {
			t.Fatalf("migration incorrectly revoked valid session: %v", err)
		}
	}
}

func TestSecureWidgetRevokeEndpointsAuthenticateCapabilities(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	secret := strings.Repeat("test-secret-", 4)
	call := func(handler func(*fastglue.Request) error, claims Claims, signingKey string) int {
		t.Helper()
		signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(signingKey))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]string{"jwt": signed})
		ctx := &fasthttp.RequestCtx{}
		ctx.Request.Header.SetMethod("POST")
		ctx.Request.Header.SetContentType("application/json")
		ctx.Request.SetBody(body)
		ctx.SetUserValue(ctxWidgetInbox, imodels.Inbox{ID: 1, Secret: null.StringFrom(secret)})
		if err := handler(&fastglue.Request{RequestCtx: ctx, Context: app}); err != nil {
			t.Fatal(err)
		}
		return ctx.Response.StatusCode()
	}
	logout := secureTestClaims("logout", "a")
	if code := call(handleSecureWidgetRevoke, logout, secret); code != 200 {
		t.Fatalf("valid logout: %d", code)
	}
	if code := call(handleSecureWidgetRevoke, logout, "wrong-key"); code != 401 {
		t.Fatalf("wrong signature: %d", code)
	}
	if code := call(handleSecureWidgetRevoke, secureTestClaims("login", "a"), secret); code != 401 {
		t.Fatalf("wrong purpose: %d", code)
	}
	migration := secureTestClaims("revoke_legacy", "a")
	migration.SessionID = ""
	migration.ExternalUserID = ""
	if code := call(handleRevokeLegacyWidgetSessions, migration, secret); code != 200 {
		t.Fatalf("migration: %d", code)
	}
	if code := call(handleRevokeLegacyWidgetSessions, migration, "wrong-key"); code != 401 {
		t.Fatalf("migration signature: %d", code)
	}
	if code := call(handleRevokeLegacyWidgetSessions, logout, secret); code != 401 {
		t.Fatalf("migration purpose: %d", code)
	}
}
