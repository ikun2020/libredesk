package main

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/textproto"
	"strings"
	"testing"

	"github.com/abhinavxd/libredesk/internal/attachment"
	"github.com/abhinavxd/libredesk/internal/inbox/channel/livechat"
	"github.com/abhinavxd/libredesk/internal/testutil"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
	"github.com/zerodha/logf"
)

func TestDecodeChatInitKeepsJSONAndMultipartMetadata(t *testing.T) {
	app := newWidgetUploadTestApp(t)
	const payload = `{"message":"图片说明","subject":"Help","form_data":{"name":"Visitor","custom_attribute_7":"answer"},"delivery_id":"delivery","browser_key":"browser","attachments":[{"name":"unvalidated.exe","content":"YQ=="}]}`
	for _, multipartBody := range []bool{false, true} {
		t.Run(fmt.Sprintf("multipart=%v", multipartBody), func(t *testing.T) {
			var req *fastglue.Request
			if multipartBody {
				req = widgetMultipartRequest(t, app, []string{payload}, true,
					widgetUploadFile{name: "picture.PNG", contentType: "image/png", body: []byte("image-bytes")})
			} else {
				req = widgetJSONRequest(app, payload)
			}
			decoded, err := decodeChatInitRequest(req)
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Message != "图片说明" || decoded.Subject != "Help" || decoded.DeliveryID != "delivery" || decoded.BrowserKey != "browser" || decoded.FormData["name"] != "Visitor" || decoded.FormData["custom_attribute_7"] != "answer" {
				t.Fatalf("chat metadata was lost: %+v", decoded)
			}
			if !multipartBody {
				if len(decoded.Attachments) != 0 {
					t.Fatal("JSON supplied unvalidated attachments")
				}
				return
			}
			if len(decoded.Attachments) != 1 {
				t.Fatalf("got %d attachments, want one", len(decoded.Attachments))
			}
			file := decoded.Attachments[0]
			if file.Name != "picture.PNG" || file.ContentType != "image/png" || file.Size != len("image-bytes") || string(file.Content) != "image-bytes" || file.Disposition != attachment.DispositionAttachment {
				t.Fatalf("attachment was not preserved: %+v", file)
			}
		})
	}
}

func TestDecodeChatInitAllowsAttachmentOnlyMessage(t *testing.T) {
	app := newWidgetUploadTestApp(t)
	req := widgetMultipartRequest(t, app, []string{`{"message":""}`}, true,
		widgetUploadFile{name: "receipt.txt", contentType: "text/plain", body: []byte("receipt")})
	decoded, err := decodeChatInitRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Message != "" || len(decoded.Attachments) != 1 {
		t.Fatalf("attachment-only message gained placeholder text or lost its file: %+v", decoded)
	}
}

func TestChatInitRejectsInvalidUploadBeforeCreatingVisitorOrConversation(t *testing.T) {
	valid := widgetUploadFile{name: "receipt.txt", contentType: "text/plain", body: []byte("receipt")}
	tests := []struct {
		name     string
		payloads []string
		files    []widgetUploadFile
		disabled bool
		wantCode int
	}{
		{name: "missing payload", files: []widgetUploadFile{valid}},
		{name: "malformed payload", payloads: []string{"{"}, files: []widgetUploadFile{valid}},
		{name: "ambiguous payload", payloads: []string{"{}", "{}"}, files: []widgetUploadFile{valid}},
		{name: "missing file", payloads: []string{`{"message":""}`}},
		{name: "empty file", payloads: []string{"{}"}, files: []widgetUploadFile{{name: "empty.txt", contentType: "text/plain"}}},
		{name: "disabled upload", payloads: []string{"{}"}, files: []widgetUploadFile{valid}, disabled: true},
		{name: "disallowed extension", payloads: []string{"{}"}, files: []widgetUploadFile{{name: "program.exe", body: []byte("bytes")}}},
		{name: "too large", payloads: []string{"{}"}, files: []widgetUploadFile{{name: "large.txt", body: bytes.Repeat([]byte{'x'}, 1024*1024+1)}}, wantCode: fasthttp.StatusRequestEntityTooLarge},
		{name: "multiple files", payloads: []string{"{}"}, files: []widgetUploadFile{valid, valid}},
		{name: "oversized text with file", payloads: []string{`{"message":"` + strings.Repeat("x", maxChatMessageLength+1) + `"}`}, files: []widgetUploadFile{valid}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// Deliberately omit user, Redis and conversation managers. Invalid input
			// must be rejected before any of these side-effecting services is used.
			app := newWidgetUploadTestApp(t)
			req := widgetMultipartRequest(t, app, tc.payloads, !tc.disabled, tc.files...)
			if err := handleChatInit(req); err != nil {
				t.Fatal(err)
			}
			wantCode := tc.wantCode
			if wantCode == 0 {
				wantCode = fasthttp.StatusBadRequest
			}
			if got := req.RequestCtx.Response.StatusCode(); got != wantCode {
				t.Fatalf("status = %d, want %d; response = %s", got, wantCode, req.RequestCtx.Response.Body())
			}
		})
	}
}

func TestChatInitStillRejectsEmptyJSONMessage(t *testing.T) {
	for _, payload := range []string{`{}`, `{"message":" \t\n"}`, `{"message":"","attachments":[{"name":"fake.txt","content":"YQ=="}]}`} {
		req := widgetJSONRequest(newWidgetUploadTestApp(t), payload)
		if err := handleChatInit(req); err != nil {
			t.Fatal(err)
		}
		if got := req.RequestCtx.Response.StatusCode(); got != fasthttp.StatusBadRequest {
			t.Fatalf("empty JSON message accepted: status %d, payload %s", got, payload)
		}
	}
}

type widgetUploadFile struct {
	name, contentType string
	body              []byte
}

func newWidgetUploadTestApp(t *testing.T) *App {
	t.Helper()
	lo := logf.New(logf.Opts{Writer: io.Discard})
	app := &App{i18n: testutil.NewI18n(t), lo: &lo}
	app.consts.Store(&constants{MaxFileUploadSizeMB: 1, AllowedUploadFileExtensions: []string{"png", "txt"}})
	return app
}

func widgetJSONRequest(app *App, payload string) *fastglue.Request {
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod("POST")
	ctx.Request.SetRequestURI("/api/v1/widget/chat/conversations/init")
	ctx.Request.Header.SetContentType("application/json")
	ctx.Request.SetBodyString(payload)
	return &fastglue.Request{RequestCtx: ctx, Context: app}
}

func widgetMultipartRequest(t *testing.T, app *App, payloads []string, enabled bool, files ...widgetUploadFile) *fastglue.Request {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for _, payload := range payloads {
		if err := w.WriteField("payload", payload); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range files {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files"; filename="%s"`, file.name))
		h.Set("Content-Type", file.contentType)
		part, err := w.CreatePart(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(file.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod("POST")
	ctx.Request.SetRequestURI("/api/v1/widget/chat/conversations/init")
	ctx.Request.Header.SetContentType(w.FormDataContentType())
	ctx.Request.SetBody(body.Bytes())
	var config livechat.Config
	config.Features.FileUpload = enabled
	ctx.SetUserValue(ctxWidgetConfig, config)
	t.Cleanup(func() { ctx.Request.RemoveMultipartFormFiles() })
	return &fastglue.Request{RequestCtx: ctx, Context: app}
}
