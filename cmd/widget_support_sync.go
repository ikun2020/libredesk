package main

import (
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

const (
	supportSyncPrefix  = "xboard-sync:"
	supportSyncPurpose = "support-sync"
)

func isSupportSyncID(id string) bool {
	return strings.HasPrefix(id, supportSyncPrefix)
}

// verifyWidgetIdentityJWT binds Support Sync identities to the signing inbox.
// Other widget integrations keep accepting the standard claims.
func verifyWidgetIdentityJWT(token, secret, inboxUUID string) (Claims, error) {
	claims, err := verifyStandardJWT(token, secret)
	if err != nil || !isSupportSyncID(claims.ExternalUserID) {
		return claims, err
	}

	account, scoped := strings.CutPrefix(claims.ExternalUserID, supportSyncPrefix+inboxUUID+":")
	if !scoped || len(account) != 64 || account != strings.ToLower(account) ||
		claims.Purpose != supportSyncPurpose || claims.UserID != 0 || claims.IsVisitor ||
		len(claims.Audience) != 1 || claims.Audience[0] != inboxUUID {
		return Claims{}, errors.New("invalid Support Sync identity scope")
	}
	if _, err := hex.DecodeString(account); err != nil {
		return Claims{}, errors.New("invalid Support Sync account identifier")
	}
	if claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.IssuedAt.After(time.Now().Add(30*time.Second)) ||
		!claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > 120*time.Second {
		return Claims{}, errors.New("invalid Support Sync credential lifetime")
	}
	return claims, nil
}
