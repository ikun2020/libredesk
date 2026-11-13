package user

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/abhinavxd/libredesk/internal/stringutil"
	"github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/volatiletech/null/v9"
)

// UpdateVisitorProfile changes only the current visitor's unverified display
// data. It never looks up, merges, or upgrades an identity by the supplied email.
// The SQL type guard also protects against a visitor being upgraded concurrently.
func (u *Manager) UpdateVisitorProfile(id int, email string, attributes map[string]string) (bool, error) {
	if id <= 0 {
		return false, nil
	}
	if attributes == nil {
		attributes = map[string]string{}
	}
	data, err := json.Marshal(attributes)
	if err != nil {
		return false, fmt.Errorf("encoding visitor profile: %w", err)
	}
	result, err := u.q.UpdateVisitorProfile.Exec(id, strings.ToLower(strings.TrimSpace(email)), data)
	if err != nil {
		return false, fmt.Errorf("updating visitor profile: %w", err)
	}
	rows, err := result.RowsAffected()
	return rows == 1, err
}

// CreateVisitor creates a new visitor user.
func (u *Manager) CreateVisitor(user *models.User) error {
	// Normalize email address.
	user.Email = null.NewString(strings.ToLower(user.Email.String), user.Email.Valid)

	if user.FirstName == "" && user.LastName == "" {
		if user.Email.Valid && user.Email.String != "" {
			user.FirstName = stringutil.CapitalizeFirst(strings.Split(user.Email.String, "@")[0])
		} else {
			user.FirstName = "Visitor"
		}
	}

	if err := u.q.InsertVisitor.Get(user, user.Email, user.FirstName, user.LastName, user.CustomAttributes, user.PhoneNumber, user.PhoneNumberCountryCode); err != nil {
		u.lo.Error("error inserting contact", "error", err)
		return fmt.Errorf("insert contact: %w", err)
	}
	return nil
}

// GetVisitor retrieves a visitor user by ID
func (u *Manager) GetVisitor(id int) (models.User, error) {
	return u.Get(id, "", []string{models.UserTypeVisitor})
}
