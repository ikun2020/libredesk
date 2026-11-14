package main

import (
	"context"
	"testing"
	"time"

	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	"github.com/alicebob/miniredis/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"github.com/zerodha/logf"
)

func newWidgetSessionTestApp(t *testing.T) *App {
	t.Helper()
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { client.Close() })
	lo := logf.New(logf.Opts{})
	return &App{redis: client, lo: &lo}
}

func TestWidgetJWTRejectsRetiredCapabilities(t *testing.T) {
	const secret = "test-inbox-secret"
	for _, tc := range []struct {
		purpose, sessionID string
	}{
		{"", ""}, {"login", "old-session"}, {"logout", "old-session"},
		{"revoke_legacy", ""}, {"unknown", ""}, {"", "old-session"},
	} {
		t.Run(tc.purpose+"/"+tc.sessionID, func(t *testing.T) {
			claims := Claims{Purpose: tc.purpose, SessionID: tc.sessionID, ExternalUserID: "xboard:123",
				RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour))}}
			signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
			if err != nil {
				t.Fatal(err)
			}
			got, err := verifyStandardJWT(signed, secret)
			if tc.purpose != "" || tc.sessionID != "" {
				if err == nil {
					t.Fatal("retired capability was accepted as a native login")
				}
			} else if err != nil || got.ExternalUserID != claims.ExternalUserID {
				t.Fatalf("native JWT rejected: %v", err)
			}
		})
	}
}

func TestWidgetSessionRejectsRetiredLeaseWithoutExtendingTTL(t *testing.T) {
	app := newWidgetSessionTestApp(t)
	token, err := generateSessionToken(app, 123, 1, false, "xboard:123", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := widgetSessionPrefix + token
	app.redis.HSet(ctx, key, "secure_scope", "widget_secure:1:old-scope", "secure_valid_until", time.Now().Add(time.Hour).Unix())
	if _, err := loadSession(app, token, livechat.Config{}); err == nil {
		t.Fatal("retired short-lease session accepted")
	}
	if ttl := app.redis.TTL(ctx, key).Val(); ttl != time.Minute {
		t.Fatalf("rejected session TTL changed: %v", ttl)
	}
}

func TestWidgetSessionHonorsExistingRevocationEpoch(t *testing.T) {
	app := newWidgetSessionTestApp(t)
	ctx := context.Background()
	create := func(inboxID int, visitor bool) string {
		t.Helper()
		token, err := generateSessionToken(app, 123, inboxID, visitor, "", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	old := create(1, false)
	otherInbox := create(2, false)
	visitor := create(1, true)
	if exists := app.redis.Exists(ctx, "widget_legacy_epoch:1").Val(); exists != 0 {
		t.Fatal("native session creation introduced a revocation epoch")
	}
	app.redis.Set(ctx, "widget_legacy_epoch:1", "previous-revocation", 0)
	if _, err := loadSession(app, old, livechat.Config{}); err == nil {
		t.Fatal("previously revoked native session revived")
	}
	if ttl := app.redis.TTL(ctx, widgetSessionPrefix+old).Val(); ttl != time.Minute {
		t.Fatalf("revoked session TTL changed: %v", ttl)
	}
	fresh := create(1, false)
	if got := app.redis.HGet(ctx, widgetSessionPrefix+fresh, "legacy_epoch").Val(); got != "previous-revocation" {
		t.Fatalf("new native session did not inherit existing epoch: %q", got)
	}
	for _, token := range []string{fresh, otherInbox, visitor} {
		if _, err := loadSession(app, token, livechat.Config{}); err != nil {
			t.Fatalf("native/visitor session rejected: %v", err)
		}
	}
	// A malformed/unavailable epoch fails closed for contacts, but visitors do
	// not depend on the retired account integration's revocation namespace.
	app.redis.Del(ctx, "widget_legacy_epoch:1")
	app.redis.HSet(ctx, "widget_legacy_epoch:1", "bad", "type")
	if _, err := loadSession(app, fresh, livechat.Config{}); err == nil {
		t.Fatal("unreadable revocation epoch accepted")
	}
	if _, err := generateSessionToken(app, 123, 1, false, "xboard:123", time.Minute); err == nil {
		t.Fatal("native session created with unreadable epoch")
	}
	if _, err := loadSession(app, visitor, livechat.Config{}); err != nil {
		t.Fatalf("visitor depended on account epoch: %v", err)
	}
}
