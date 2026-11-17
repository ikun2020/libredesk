package main

import (
	amodels "github.com/abhinavxd/libredesk/internal/auth/models"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/zerodha/fastglue"
)

func handleEditLiveChatMessage(r *fastglue.Request) error {
	return handleChangeLiveChatMessage(r, false)
}

func handleRecallLiveChatMessage(r *fastglue.Request) error {
	return handleChangeLiveChatMessage(r, true)
}

func handleChangeLiveChatMessage(r *fastglue.Request, recall bool) error {
	app := r.Context.(*App)
	conversationUUID := r.RequestCtx.UserValue("cuuid").(string)
	messageUUID := r.RequestCtx.UserValue("uuid").(string)
	user, err := app.user.GetAgentCachedOrLoad(r.RequestCtx.UserValue("user").(amodels.User).ID)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	var req struct {
		Content string `json:"content"`
	}
	if !recall {
		if err := r.Decode(&req, "json"); err != nil {
			return sendErrorEnvelope(r, envelope.NewError(envelope.InputError, app.i18n.T("errors.parsingRequest"), nil))
		}
	}
	update, err := app.conversation.ChangeLiveChatMessage(conversationUUID, messageUUID, user, req.Content, recall)
	if err != nil {
		return sendErrorEnvelope(r, err)
	}
	return r.SendEnvelope(update)
}
