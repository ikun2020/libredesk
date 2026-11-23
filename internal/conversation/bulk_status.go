package conversation

import (
	"fmt"
	"slices"
	"time"

	"github.com/abhinavxd/libredesk/internal/authz"
	"github.com/abhinavxd/libredesk/internal/dbutil"
	"github.com/abhinavxd/libredesk/internal/envelope"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/volatiletech/null/v9"
)

type BulkOpenConversation struct {
	UUID           string    `db:"uuid"`
	UpdatedAt      time.Time `db:"updated_at"`
	AssignedUserID null.Int  `db:"assigned_user_id"`
	AssignedTeamID null.Int  `db:"assigned_team_id"`
}

// GetBulkOpenConversations returns all matching open conversations that the agent may access.
func (c *Manager) GetBulkOpenConversations(user umodels.User, teamIDs []int, listTypes []string, filters string) ([]BulkOpenConversation, error) {
	if len(listTypes) == 0 {
		return nil, fmt.Errorf("no conversation list types specified")
	}
	var args []any
	conditions, err := appendListTypeConditions(listTypes, user.ID, user.ID, teamIDs, &args)
	if err != nil {
		return nil, err
	}
	baseQuery := fmt.Sprintf(c.q.GetBulkOpenConversationCandidates, listTypeWhereClause(conditions))
	query, args, err := dbutil.BuildFilterQuery(baseQuery, args, filters, ListFilterAllowedFields, ListFilterRenderers, c.FilterLocation())
	if err != nil {
		c.lo.Debug("error building bulk conversation filters", "error", err)
		return nil, envelope.NewError(envelope.InputError, c.i18n.T("globals.messages.invalidFilters"), nil)
	}
	var matches []BulkOpenConversation
	if err := c.db.Select(&matches, query+" ORDER BY conversations.uuid", args...); err != nil {
		c.lo.Error("error querying bulk conversation candidates", "error", err)
		return nil, envelope.NewError(envelope.GeneralError, c.i18n.T("globals.messages.somethingWentWrong"), nil)
	}
	return slices.DeleteFunc(matches, func(match BulkOpenConversation) bool {
		return !authz.CanReadAssignment(user, match.AssignedUserID, match.AssignedTeamID)
	}), nil
}
