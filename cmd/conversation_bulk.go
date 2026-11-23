package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"

	amodels "github.com/abhinavxd/libredesk/internal/auth/models"
	authzmodels "github.com/abhinavxd/libredesk/internal/authz/models"
	"github.com/abhinavxd/libredesk/internal/conversation"
	cmodels "github.com/abhinavxd/libredesk/internal/conversation/models"
	"github.com/abhinavxd/libredesk/internal/envelope"
	umodels "github.com/abhinavxd/libredesk/internal/user/models"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

type bulkConversationStatusRequest struct {
	ListType string `json:"list_type"`
	ListID   int    `json:"list_id"`
	Filters  string `json:"filters"`
	Status   string `json:"status"`
	Preview  bool   `json:"preview"`
	Snapshot string `json:"snapshot"`
}

type bulkConversationStatusResult struct {
	Total    int    `json:"total"`
	Updated  int    `json:"updated"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
	Snapshot string `json:"snapshot"`
}

func handleBulkConversationStatus(r *fastglue.Request) error {
	app := r.Context.(*App)
	auser := r.RequestCtx.UserValue("user").(amodels.User)
	var req bulkConversationStatusRequest
	if err := r.Decode(&req, "json"); err != nil ||
		(req.Status != cmodels.StatusResolved && req.Status != cmodels.StatusClosed) ||
		(!req.Preview && req.Snapshot == "") {
		return r.SendErrorEnvelope(fasthttp.StatusBadRequest, app.i18n.T("globals.messages.badRequest"), nil, envelope.InputError)
	}
	user, err := app.user.GetAgentCachedOrLoad(auser.ID)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	lists, teamIDs, filters, err := getBulkConversationScope(app, user, req)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	candidates, err := app.conversation.GetBulkOpenConversations(user, teamIDs, lists, filters)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	result := bulkConversationStatusResult{
		Total:    len(candidates),
		Snapshot: bulkConversationSnapshot(user.ID, req.Status, candidates),
	}
	if req.Preview {
		return r.SendEnvelope(result)
	}
	if req.Snapshot != result.Snapshot {
		return r.SendErrorEnvelope(fasthttp.StatusConflict, app.i18n.T("conversation.bulkActions.inboxChanged"), nil, envelope.ConflictError)
	}

	for _, candidate := range candidates {
		uuid := candidate.UUID
		current, err := app.conversation.GetConversation(0, uuid, "")
		if err != nil {
			result.Failed++
			continue
		}
		if !current.UpdatedAt.Equal(candidate.UpdatedAt) || current.AssignedUserID != candidate.AssignedUserID ||
			current.AssignedTeamID != candidate.AssignedTeamID {
			result.Skipped++
			continue
		}
		changed, err := app.conversation.UpdateOpenConversationStatus(current, req.Status, user)
		if err != nil {
			app.lo.Error("error applying bulk conversation status", "uuid", uuid, "status", req.Status, "error", err)
		}
		switch {
		case changed:
			result.Updated++
			markAssignmentNotificationRead(app, &current, user)
		case err != nil:
			result.Failed++
		default:
			result.Skipped++
		}
	}
	return r.SendEnvelope(result)
}

func getBulkConversationScope(app *App, user umodels.User, req bulkConversationStatusRequest) ([]string, []int, string, error) {
	denied := envelope.NewError(envelope.PermissionError, app.i18n.T("status.deniedPermission"), nil)
	if !slices.Contains(user.Permissions, authzmodels.PermConversationsRead) {
		return nil, nil, "", denied
	}

	if req.ListType == "view" {
		if req.ListID < 1 {
			return nil, nil, "", envelope.NewError(envelope.InputError, app.i18n.T("globals.messages.badRequest"), nil)
		}
		view, err := app.view.Get(req.ListID)
		if err != nil {
			return nil, nil, "", err
		}
		teamIDs := user.Teams.IDs()
		if !conversation.UserCanAccessView(view, user.ID, teamIDs) {
			return nil, nil, "", envelope.NewError(envelope.PermissionError, app.i18n.T("conversation.viewPermissionDenied"), nil)
		}
		lists := conversation.ListsForUserPermissions(user.Permissions)
		if len(lists) == 0 {
			return nil, nil, "", denied
		}
		return lists, teamIDs, string(view.Filters), nil
	}

	var perm string
	switch req.ListType {
	case cmodels.AssignedConversations:
		perm = authzmodels.PermConversationsReadAssigned
	case cmodels.AllConversations:
		perm = authzmodels.PermConversationsReadAll
	case cmodels.UnassignedConversations:
		perm = authzmodels.PermConversationsReadUnassigned
	case cmodels.TeamUnassignedConversations:
		perm = authzmodels.PermConversationsReadTeamInbox
	case cmodels.MentionedConversations:
		perm = authzmodels.PermConversationsRead
	default:
		return nil, nil, "", envelope.NewError(envelope.InputError, app.i18n.T("globals.messages.badRequest"), nil)
	}
	if !slices.Contains(user.Permissions, perm) {
		return nil, nil, "", denied
	}
	var teamIDs []int
	if req.ListType == cmodels.TeamUnassignedConversations {
		if req.ListID < 1 {
			return nil, nil, "", envelope.NewError(envelope.InputError, app.i18n.T("globals.messages.badRequest"), nil)
		}
		member, err := app.team.UserBelongsToTeam(req.ListID, user.ID)
		if err != nil {
			return nil, nil, "", err
		}
		if !member {
			return nil, nil, "", envelope.NewError(envelope.PermissionError, app.i18n.T("conversation.notMemberOfTeam"), nil)
		}
		teamIDs = []int{req.ListID}
	}
	return []string{req.ListType}, teamIDs, req.Filters, nil
}

func bulkConversationSnapshot(userID int, status string, candidates []conversation.BulkOpenConversation) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "%d\n%s\n", userID, status)
	for _, candidate := range candidates {
		fmt.Fprintln(hash, candidate.UUID)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
