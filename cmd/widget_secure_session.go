package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/redis/go-redis/v9"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

const (
	secureWidgetLoginLifetime = 5 * time.Minute
	secureWidgetLease         = 10 * time.Minute
	secureWidgetRetention     = 24 * time.Hour
)

// The protocol probe lets integrations fail closed against older servers that
// would silently ignore session_id and create a long-lived legacy session.
func handleWidgetSecurityProtocol(r *fastglue.Request) error {
	r.RequestCtx.Response.Header.Set("Cache-Control", "no-store")
	return r.SendEnvelope(map[string]any{"protocol": 1})
}

func validateSecureWidgetClaims(claims Claims, purpose string, now time.Time) error {
	if claims.Purpose != purpose || (purpose != "login" && purpose != "logout") {
		return fmt.Errorf("invalid widget capability purpose")
	}
	if len(claims.SessionID) != 64 || strings.ToLower(claims.SessionID) != claims.SessionID {
		return fmt.Errorf("invalid widget session scope")
	}
	if _, err := hex.DecodeString(claims.SessionID); err != nil {
		return fmt.Errorf("invalid widget session scope")
	}
	if claims.ExternalUserID == "" || len(claims.ExternalUserID) > maxExternalUserIDLength {
		return fmt.Errorf("invalid widget identity")
	}
	limit := secureWidgetLoginLifetime
	if purpose == "logout" {
		limit = secureWidgetRetention
	}
	if claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.IssuedAt.Unix() <= 0 ||
		claims.IssuedAt.After(now.Add(30*time.Second)) || !claims.ExpiresAt.After(now) ||
		!claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > limit {
		return fmt.Errorf("invalid widget capability lifetime")
	}
	return nil
}

func secureWidgetScope(inboxID int, claims Claims) string {
	digest := sha256.Sum256([]byte(claims.ExternalUserID + "\x00" + claims.SessionID))
	return fmt.Sprintf("widget_secure:%d:%x", inboxID, digest)
}

func checkSecureWidgetRevocation(app *App, inboxID int, claims Claims) error {
	blocked, err := app.redis.Exists(context.Background(), secureWidgetScope(inboxID, claims)+":revoked").Result()
	if err != nil || blocked != 0 {
		return fmt.Errorf("widget login revoked or unavailable")
	}
	return nil
}

// Exchange and revoke are serialized by Redis. In particular, an exchange
// started before logout must not recreate a session after the tombstone lands.
var exchangeSecureWidgetScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return '' end
local token = redis.call('GET', KEYS[2])
if token then
  local old = ARGV[1] .. token
  if redis.call('HGET', old, 'user_id') ~= ARGV[3] then
    redis.call('DEL', old)
    token = false
  end
end
if not token then token = ARGV[2] end
local key = ARGV[1] .. token
local until_at = tonumber(redis.call('HGET', key, 'secure_valid_until') or '0')
until_at = math.max(until_at, tonumber(ARGV[7]))
redis.call('HSET', key, 'user_id', ARGV[3], 'inbox_id', ARGV[4],
  'is_visitor', 'false', 'external_user_id', ARGV[5],
  'secure_scope', ARGV[6], 'secure_valid_until', tostring(until_at))
redis.call('EXPIRE', key, ARGV[8])
redis.call('SET', KEYS[2], token, 'EX', ARGV[8])
local legacy = redis.call('GET', KEYS[3])
if legacy then redis.call('DEL', ARGV[1] .. legacy) end
redis.call('DEL', KEYS[3])
return token
`)

func exchangeSecureWidgetSession(app *App, userID, inboxID int, claims Claims) (string, error) {
	if err := validateSecureWidgetClaims(claims, "login", time.Now()); err != nil {
		return "", err
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	scope := secureWidgetScope(inboxID, claims)
	token, err := exchangeSecureWidgetScript.Run(context.Background(), app.redis,
		[]string{scope + ":revoked", scope + ":token", fmt.Sprintf("widget_user:%d:%d", inboxID, userID)},
		widgetSessionPrefix, base64.RawURLEncoding.EncodeToString(random[:]), userID, inboxID,
		claims.ExternalUserID, scope, claims.IssuedAt.Add(secureWidgetLease).Unix(), int(secureWidgetRetention.Seconds()),
	).Text()
	if err != nil || token == "" {
		return "", fmt.Errorf("widget login revoked or unavailable")
	}
	return token, nil
}

var revokeSecureWidgetScript = redis.NewScript(`
redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
local token = redis.call('GET', KEYS[2])
if token then redis.call('DEL', ARGV[1] .. token) end
redis.call('DEL', KEYS[2])
return 1
`)

func revokeSecureWidgetSession(app *App, inboxID int, claims Claims) error {
	if err := validateSecureWidgetClaims(claims, "logout", time.Now()); err != nil {
		return err
	}
	scope := secureWidgetScope(inboxID, claims)
	return revokeSecureWidgetScript.Run(context.Background(), app.redis,
		[]string{scope + ":revoked", scope + ":token"}, widgetSessionPrefix, int(secureWidgetLease.Seconds())).Err()
}

func handleSecureWidgetRevoke(r *fastglue.Request) error {
	app := r.Context.(*App)
	inbox, err := getWidgetInbox(r)
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid widget capability", nil, envelope.UnauthorizedError)
	}
	var req struct {
		JWT string `json:"jwt"`
	}
	if err := r.Decode(&req, "json"); err != nil || len(req.JWT) > 8192 {
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, "Invalid widget capability", nil, envelope.InputError)
	}
	claims, err := verifyStandardJWT(req.JWT, inbox.Secret.String)
	if err != nil || validateSecureWidgetClaims(claims, "logout", time.Now()) != nil {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid widget capability", nil, envelope.UnauthorizedError)
	}
	if err := revokeSecureWidgetSession(app, inbox.ID, claims); err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusServiceUnavailable, "Unable to revoke widget session", nil, envelope.GeneralError)
	}
	r.RequestCtx.Response.Header.Set("Cache-Control", "no-store")
	return r.SendEnvelope(map[string]any{"revoked": true})
}

func legacyWidgetEpochKey(inboxID int) string {
	return fmt.Sprintf("widget_legacy_epoch:%d", inboxID)
}

// A one-time per-inbox epoch invalidates old authenticated sessions without a
// Redis scan and without deleting contacts or conversations. It intentionally
// survives retries and plugin cache expiry. Visitors are not account sessions.
func migrateLegacyWidgetSessions(app *App, inboxID int) error {
	var epoch [32]byte
	if _, err := rand.Read(epoch[:]); err != nil {
		return err
	}
	return app.redis.SetNX(context.Background(), legacyWidgetEpochKey(inboxID), hex.EncodeToString(epoch[:]), 0).Err()
}

func handleRevokeLegacyWidgetSessions(r *fastglue.Request) error {
	app := r.Context.(*App)
	inbox, err := getWidgetInbox(r)
	if err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid widget capability", nil, envelope.UnauthorizedError)
	}
	var req struct {
		JWT string `json:"jwt"`
	}
	if err := r.Decode(&req, "json"); err != nil || len(req.JWT) > 8192 {
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, "Invalid widget capability", nil, envelope.InputError)
	}
	claims, err := verifyStandardJWT(req.JWT, inbox.Secret.String)
	now := time.Now()
	if err != nil || claims.Purpose != "revoke_legacy" || claims.SessionID != "" || claims.ExternalUserID != "" ||
		claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.IssuedAt.Unix() <= 0 ||
		claims.IssuedAt.After(now.Add(30*time.Second)) || !claims.ExpiresAt.After(now) ||
		!claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > secureWidgetLoginLifetime {
		return r.SendErrorEnvelope(fasthttp.StatusUnauthorized, "Invalid widget capability", nil, envelope.UnauthorizedError)
	}
	if err := migrateLegacyWidgetSessions(app, inbox.ID); err != nil {
		return r.SendErrorEnvelope(fasthttp.StatusServiceUnavailable, "Unable to revoke widget sessions", nil, envelope.GeneralError)
	}
	r.RequestCtx.Response.Header.Set("Cache-Control", "no-store")
	return r.SendEnvelope(map[string]any{"revoked": true})
}

func validateLegacyWidgetSessionData(app *App, data map[string]string) error {
	if data["is_visitor"] == "true" {
		return nil
	}
	inboxID, err := strconv.Atoi(data["inbox_id"])
	if err != nil {
		return fmt.Errorf("invalid widget inbox")
	}
	epoch, err := app.redis.Get(context.Background(), legacyWidgetEpochKey(inboxID)).Result()
	if err != nil && err != redis.Nil {
		return fmt.Errorf("widget session validation unavailable")
	}
	if err == nil && epoch != data["legacy_epoch"] {
		return fmt.Errorf("widget session revoked")
	}
	return nil
}

func validateSecureWidgetSessionData(app *App, data map[string]string) error {
	until, err := strconv.ParseInt(data["secure_valid_until"], 10, 64)
	if err != nil || until <= time.Now().Unix() || data["secure_scope"] == "" {
		return fmt.Errorf("widget session expired")
	}
	blocked, err := app.redis.Exists(context.Background(), data["secure_scope"]+":revoked").Result()
	if err != nil || blocked != 0 {
		return fmt.Errorf("widget session revoked or unavailable")
	}
	return nil
}

// Used by both directions of an established WebSocket; a successful join must
// not authorize that connection forever after logout or a lease expiry.
func widgetSessionActive(app *App, token string) bool {
	data, err := app.redis.HGetAll(context.Background(), widgetSessionPrefix+token).Result()
	if err != nil || len(data) == 0 {
		return false
	}
	if data["secure_scope"] != "" {
		return validateSecureWidgetSessionData(app, data) == nil
	}
	return validateLegacyWidgetSessionData(app, data) == nil
}
