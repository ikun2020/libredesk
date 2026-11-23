package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	ldcrypto "github.com/abhinavxd/libredesk/internal/crypto"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	imodels "github.com/abhinavxd/libredesk/internal/inbox/models"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/valyala/fasthttp"
	"github.com/volatiletech/null/v9"
	"github.com/zerodha/fastglue"
)

const (
	hdrWidgetPendingIdentity = "X-Libredesk-Pending-Identity"
	ctxWidgetPendingIdentity = "widget_pending_identity"
	pendingIdentityPrefix    = "support-sync-pending-v1:"
	maxPendingIdentityTTL    = 2 * time.Hour
	maxPendingIdentityBytes  = 16 << 10
)

type pendingWidgetIdentity struct {
	Claims    Claims `json:"claims"`
	ExpiresAt int64  `json:"expires_at"`
}

func pendingIdentityKey(inbox imodels.Inbox) string {
	mac := hmac.New(sha256.New, []byte(inbox.Secret.String))
	_, _ = mac.Write([]byte(pendingIdentityPrefix + inbox.UUID))
	return string(mac.Sum(nil))
}

// A pending identity is held only by the support frame and accepted only by the
// widget's first-message path and optional audience checks. No claims enter Redis.
func sealWidgetPendingIdentity(inbox imodels.Inbox, claims Claims, ttl time.Duration, now time.Time) (string, error) {
	if inbox.Secret.String == "" || !validSupportSyncScope(claims, inbox.UUID) || ttl <= 0 {
		return "", errors.New("invalid pending widget identity")
	}
	payload, err := json.Marshal(pendingWidgetIdentity{Claims: claims, ExpiresAt: now.Add(min(ttl, maxPendingIdentityTTL)).Unix()})
	if err != nil {
		return "", err
	}
	ciphertext, err := ldcrypto.Encrypt(string(payload), pendingIdentityKey(inbox))
	if err != nil {
		return "", err
	}
	token := pendingIdentityPrefix + ciphertext
	if len(token) > maxPendingIdentityBytes {
		return "", errors.New("pending widget identity too large")
	}
	return token, nil
}

func openWidgetPendingIdentity(inbox imodels.Inbox, token string, now time.Time) (Claims, error) {
	invalid := errors.New("invalid pending widget identity")
	ciphertext, scoped := strings.CutPrefix(token, pendingIdentityPrefix)
	if inbox.Secret.String == "" || len(token) > maxPendingIdentityBytes || !scoped || !ldcrypto.IsEncrypted(ciphertext) {
		return Claims{}, invalid
	}
	plaintext, err := ldcrypto.Decrypt(ciphertext, pendingIdentityKey(inbox))
	if err != nil {
		return Claims{}, invalid
	}
	var pending pendingWidgetIdentity
	if json.Unmarshal([]byte(plaintext), &pending) != nil || !validSupportSyncScope(pending.Claims, inbox.UUID) ||
		pending.ExpiresAt <= now.Unix() || pending.ExpiresAt > now.Add(maxPendingIdentityTTL).Unix() {
		return Claims{}, invalid
	}
	return pending.Claims, nil
}

func acceptWidgetPendingIdentity(r *fastglue.Request) error {
	app := r.Context.(*App)
	r.RequestCtx.Response.Header.Set("Cache-Control", "no-store")
	inbox, err := getWidgetInbox(r)
	if err != nil {
		return pendingWidgetIdentityDenied(app)
	}
	claims, err := openWidgetPendingIdentity(inbox, string(r.RequestCtx.Request.Header.Peek(hdrWidgetPendingIdentity)), time.Now())
	if err != nil {
		return pendingWidgetIdentityDenied(app)
	}
	r.RequestCtx.SetUserValue(ctxWidgetPendingIdentity, claims)
	r.RequestCtx.SetUserValue(ctxWidgetIsVisitor, false)
	return nil
}

func pendingWidgetIdentityDenied(app *App) error {
	return envelope.NewErrorWithCode(envelope.UnauthorizedError, fasthttp.StatusUnauthorized, app.i18n.T("globals.terms.unAuthorized"), nil)
}

func getWidgetPendingIdentity(r *fastglue.Request) (Claims, bool) {
	claims, ok := r.RequestCtx.UserValue(ctxWidgetPendingIdentity).(Claims)
	return claims, ok
}

// Read by the verified external ID, never by the account's email address.
func findWidgetSupportContact(app *App, claims Claims) (umodels.User, error) {
	user, err := app.user.GetContactByExternalID(claims.ExternalUserID)
	if err != nil {
		if envErr, ok := err.(envelope.Error); ok && envErr.ErrorType == envelope.NotFoundError {
			return umodels.User{}, nil
		}
		return umodels.User{}, err
	}
	if !user.Enabled {
		return umodels.User{}, pendingWidgetIdentityDenied(app)
	}
	return user, nil
}

func knownWidgetSupportHistory(app *App, inbox imodels.Inbox, config livechat.Config, claims Claims, visitorToken string) (bool, error) {
	user, err := findWidgetSupportContact(app, claims)
	if err != nil {
		return false, err
	}
	if user.ID > 0 {
		if hasHistory, err := app.conversation.HasWidgetContactIncomingHistory(user.ID, inbox.ID); err != nil || hasHistory {
			return hasHistory, err
		}
	}
	if visitorToken == "" || len(visitorToken) > 256 {
		return false, nil
	}
	session, err := loadSession(app, visitorToken, config)
	if err != nil || !session.IsVisitor || session.InboxID != inbox.ID || session.UserID <= 0 {
		return false, nil
	}
	visitor, err := app.user.GetVisitor(session.UserID)
	if err != nil || !visitor.Enabled || visitor.ExternalUserID.Valid {
		return false, nil
	}
	return app.conversation.HasWidgetContactIncomingHistory(session.UserID, inbox.ID)
}

func prepareWidgetPendingContact(r *fastglue.Request, inbox imodels.Inbox, config livechat.Config, claims Claims) (umodels.User, string, error) {
	app := r.Context.(*App)
	contact, err := findWidgetSupportContact(app, claims)
	if err != nil {
		return umodels.User{}, "", err
	}
	if err := checkConversationPermissions(app, config, false, contact.ID, inbox.ID); err != nil {
		return umodels.User{}, "", err
	}
	if contact.ID == 0 {
		// The upsert never overwrites existing non-empty fields with blank input.
		// Keep the account key only until the first message has been saved.
		contact.ExternalUserID = null.StringFrom(claims.ExternalUserID)
		if err := app.user.ResolveContact(&contact, umodels.ContactSyncExternalID); err != nil {
			return umodels.User{}, "", err
		}
		contact, err = findWidgetSupportContact(app, claims)
		if err != nil {
			return umodels.User{}, "", err
		}
		if contact.ID == 0 {
			return umodels.User{}, "", pendingWidgetIdentityDenied(app)
		}
	}
	token, err := generateSessionToken(app, contact.ID, inbox.ID, false, claims.ExternalUserID, getSessionDuration(config))
	if err != nil {
		return umodels.User{}, "", err
	}
	contact.FirstName, contact.LastName = claims.FirstName, claims.LastName
	return contact, token, nil
}

func saveWidgetPendingProfile(app *App, inbox imodels.Inbox, contactID int, token string, claims Claims) {
	if err := app.user.UpdateContactBasicInfo(contactID, claims.FirstName, claims.LastName, claims.Email, claims.PhoneNumber, claims.PhoneNumberCountryCode); err != nil {
		app.lo.Error("error updating Support Sync contact after first message", "contact_id", contactID)
	}
	if len(claims.ContactCustomAttributes) > 0 {
		if err := app.user.SaveCustomAttributes(contactID, claims.ContactCustomAttributes, false); err != nil {
			app.lo.Error("error saving Support Sync attributes after first message", "contact_id", contactID)
		}
	}
	var config livechat.Config
	if json.Unmarshal(inbox.Config, &config) == nil {
		key := fmt.Sprintf("widget_user:%d:%d", inbox.ID, contactID)
		if err := app.redis.Set(context.Background(), key, token, getSessionDuration(config)).Err(); err != nil {
			app.lo.Warn("error indexing widget session", "inbox_id", inbox.ID, "contact_id", contactID)
		}
	}
}
