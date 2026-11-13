package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/abhinavxd/libredesk/internal/stringutil"
	"github.com/zerodha/fastglue"
)

const (
	maxVisitorProfileBytes          = 4096
	maxVisitorProfileAttributeBytes = 256
)

// visitorProfile is unverified browser-provided context, not an identity or a
// capability. Deliberately exclude contact IDs, external IDs and session tokens.
type visitorProfile struct {
	Email                   string            `json:"email"`
	ContactCustomAttributes map[string]string `json:"contact_custom_attributes,omitempty"`
}

func (p *visitorProfile) UnmarshalJSON(data []byte) error {
	invalid := errors.New("invalid visitor profile")
	if len(data) > maxVisitorProfileBytes || !utf8.Valid(data) {
		return invalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return invalid
	}
	for key := range fields {
		if key != "email" && key != "contact_custom_attributes" {
			return invalid
		}
	}
	readString := func(raw json.RawMessage, max int) (string, bool) {
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 || raw[0] != '"' {
			return "", false
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || len(value) > max || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return "", false
		}
		return value, true
	}
	email, ok := readString(fields["email"], maxEmailLength)
	email = strings.ToLower(strings.TrimSpace(email))
	if !ok || email == "" || !stringutil.ValidEmail(email) {
		return invalid
	}
	attrs := make(map[string]string)
	if raw, exists := fields["contact_custom_attributes"]; exists {
		var values map[string]json.RawMessage
		if json.Unmarshal(raw, &values) != nil || values == nil || len(values) > 5 {
			return invalid
		}
		for key, raw := range values {
			switch key {
			case "xboard_used_traffic", "xboard_expires_at", "xboard_balance", "xboard_total_traffic", "xboard_plan":
			default:
				return invalid
			}
			value, ok := readString(raw, maxVisitorProfileAttributeBytes)
			if !ok {
				return invalid
			}
			attrs[key] = value
		}
	}
	*p = visitorProfile{Email: email, ContactCustomAttributes: attrs}
	return nil
}

func visitorProfileDenied() error {
	return envelope.NewError(envelope.PermissionError, "Visitor profile updates require the current visitor session", nil)
}

func saveWidgetVisitorProfile(app *App, contactID int, isVisitor bool, profile *visitorProfile) error {
	if !isVisitor || contactID <= 0 || profile == nil {
		return visitorProfileDenied()
	}
	// The token flag alone is insufficient: the database user may have been
	// upgraded or merged since that visitor token was issued.
	visitor, err := app.user.GetVisitor(contactID)
	if err != nil || !visitor.Enabled || visitor.ExternalUserID.Valid {
		return visitorProfileDenied()
	}
	updated, err := app.user.UpdateVisitorProfile(contactID, profile.Email, profile.ContactCustomAttributes)
	if err != nil {
		app.lo.Error("error saving widget visitor profile", "contact_id", contactID)
		return envelope.NewError(envelope.GeneralError, app.i18n.T("globals.messages.somethingWentWrong"), nil)
	}
	if !updated {
		return visitorProfileDenied()
	}
	return nil
}

// handleWidgetVisitorProfile only updates an existing visitor authorized by
// widgetAuth. It cannot create a visitor, conversation, message or login session.
func handleWidgetVisitorProfile(r *fastglue.Request) error {
	app := r.Context.(*App)
	var profile visitorProfile
	body := r.RequestCtx.PostBody()
	if len(body) > maxVisitorProfileBytes || json.Unmarshal(body, &profile) != nil {
		return sendErrorEnvelope(r, envelope.NewError(envelope.InputError, "Invalid visitor profile", nil))
	}
	contactID, err := getWidgetContactID(r)
	if err != nil {
		return sendErrorEnvelope(r, visitorProfileDenied())
	}
	if err := saveWidgetVisitorProfile(app, contactID, getWidgetIsVisitor(r), &profile); err != nil {
		return sendErrorEnvelope(r, err)
	}
	return r.SendEnvelope(true)
}
