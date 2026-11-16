package main

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestSupportSyncCredentialScope(t *testing.T) {
	const (
		inbox = "8791160e-39c2-4fcf-b4b6-80a882c6c628"
		other = "9d339fd7-564b-4ab1-8edd-396b4e1639a5"
		key   = "test-inbox-secret"
	)
	now := time.Now()
	for _, tc := range []struct {
		name string
		edit func(*Claims)
		alg  *jwt.SigningMethodHMAC
		key  string
		want bool
	}{
		{name: "same inbox", want: true},
		{name: "wrong key", key: "different-secret"},
		{name: "forged inbox inside id", edit: func(c *Claims) { c.ExternalUserID = supportSyncPrefix + other + ":" + strings.Repeat("a", 64) }},
		{name: "wrong audience", edit: func(c *Claims) { c.Audience = jwt.ClaimStrings{other} }},
		{name: "multiple audiences", edit: func(c *Claims) { c.Audience = append(c.Audience, other) }},
		{name: "numeric contact selector", edit: func(c *Claims) { c.UserID = 22 }},
		{name: "visitor selector", edit: func(c *Claims) { c.IsVisitor = true }},
		{name: "not an opaque account id", edit: func(c *Claims) { c.ExternalUserID = supportSyncPrefix + inbox + ":" + strings.Repeat("g", 64) }},
		{name: "missing purpose", edit: func(c *Claims) { c.Purpose = "" }},
		{name: "missing iat", edit: func(c *Claims) { c.IssuedAt = nil }},
		{name: "future iat", edit: func(c *Claims) { c.IssuedAt = jwt.NewNumericDate(now.Add(time.Minute)) }},
		{name: "excess credential duration", edit: func(c *Claims) { c.ExpiresAt = jwt.NewNumericDate(now.Add(3 * time.Minute)) }},
		{name: "non-HS256", alg: jwt.SigningMethodHS384},
		{name: "standard JWT", edit: func(c *Claims) { c.ExternalUserID = "normal:42"; c.Purpose = ""; c.Audience = nil; c.IssuedAt = nil }, want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := Claims{
				ExternalUserID: supportSyncPrefix + inbox + ":" + strings.Repeat("a", 64),
				Purpose:        supportSyncPurpose,
				RegisteredClaims: jwt.RegisteredClaims{
					Audience: jwt.ClaimStrings{inbox}, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(2 * time.Minute)),
				},
			}
			if tc.edit != nil {
				tc.edit(&c)
			}
			alg := tc.alg
			if alg == nil {
				alg = jwt.SigningMethodHS256
			}
			signingKey := tc.key
			if signingKey == "" {
				signingKey = key
			}
			token, err := jwt.NewWithClaims(alg, c).SignedString([]byte(signingKey))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := verifyWidgetIdentityJWT(token, key, inbox); (err == nil) != tc.want {
				t.Fatalf("valid=%v want=%v: %v", err == nil, tc.want, err)
			}
		})
	}
}
