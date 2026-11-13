package main

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"slices"
	"strings"

	"github.com/abhinavxd/libredesk/internal/attachment"
	"github.com/abhinavxd/libredesk/internal/envelope"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	"github.com/abhinavxd/libredesk/internal/stringutil"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

// decodeChatInitRequest keeps the JSON API intact while allowing a first message
// to include a file. All attachment validation happens before creating a visitor
// or conversation; selecting/canceling a file picker needs no server-side draft.
func decodeChatInitRequest(r *fastglue.Request) (chatInitReq, error) {
	app := r.Context.(*App)
	var req chatInitReq
	contentType := strings.TrimSpace(strings.SplitN(string(r.RequestCtx.Request.Header.ContentType()), ";", 2)[0])
	if !strings.EqualFold(contentType, "multipart/form-data") {
		if err := r.Decode(&req, "json"); err != nil {
			return req, envelope.NewError(envelope.InputError, app.i18n.T("errors.parsingRequest"), nil)
		}
		return req, nil
	}

	form, err := r.RequestCtx.MultipartForm()
	if err != nil {
		return req, envelope.NewError(envelope.InputError, app.i18n.T("errors.parsingRequest"), nil)
	}
	payload := form.Value["payload"]
	if len(payload) != 1 || json.Unmarshal([]byte(payload[0]), &req) != nil {
		return req, envelope.NewError(envelope.InputError, app.i18n.T("errors.parsingRequest"), nil)
	}
	config, err := getWidgetConfig(r)
	if err != nil {
		return req, envelope.NewError(envelope.GeneralError, app.i18n.T("globals.messages.somethingWentWrong"), nil)
	}
	req.Attachments, err = readWidgetUpload(app, form.File["files"], config)
	return req, err
}

// readWidgetUpload applies the same policy to initial and subsequent widget
// attachments. The widget's picker accepts one file; reject extra files rather
// than silently dropping them or letting a batch bypass the per-upload limit.
func readWidgetUpload(app *App, files []*multipart.FileHeader, config livechat.Config) (attachment.Attachments, error) {
	if !config.Features.FileUpload {
		return nil, envelope.NewError(envelope.InputError, app.i18n.T("status.disabledFileUpload"), nil)
	}
	if len(files) == 0 {
		return nil, envelope.NewError(envelope.InputError, app.i18n.T("validation.notFoundFile"), nil)
	}
	if len(files) != 1 {
		return nil, envelope.NewError(envelope.InputError, app.i18n.T("errors.parsingRequest"), nil)
	}
	fileHeader := files[0]
	name := stringutil.SanitizeFilename(fileHeader.Filename)
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	if fileHeader.Size <= 0 {
		return nil, envelope.NewError(envelope.InputError, app.i18n.T("media.fileEmpty"), nil)
	}
	consts := app.consts.Load().(*constants)
	if bytesToMegabytes(fileHeader.Size) > float64(consts.MaxFileUploadSizeMB) {
		return nil, envelope.NewErrorWithCode(envelope.GeneralError, fasthttp.StatusRequestEntityTooLarge,
			app.i18n.Ts("media.fileSizeTooLarge", "size", fmt.Sprintf("%dMB", consts.MaxFileUploadSizeMB)), nil)
	}
	if !slices.Contains(consts.AllowedUploadFileExtensions, "*") && !slices.Contains(consts.AllowedUploadFileExtensions, ext) {
		return nil, envelope.NewError(envelope.InputError, app.i18n.T("media.fileTypeNotAllowed"), nil)
	}
	file, err := fileHeader.Open()
	if err != nil {
		app.lo.Error("error reading uploaded widget file", "error", err)
		return nil, envelope.NewError(envelope.GeneralError, app.i18n.T("globals.messages.somethingWentWrong"), nil)
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil {
		app.lo.Error("error reading widget file content", "error", err)
		return nil, envelope.NewError(envelope.GeneralError, app.i18n.T("globals.messages.somethingWentWrong"), nil)
	}
	return attachment.Attachments{{
		Name: name, ContentType: fileHeader.Header.Get("Content-Type"),
		Size: len(content), Content: content, Disposition: attachment.DispositionAttachment,
	}}, nil
}
