package main

import (
	"encoding/json"
	"testing"

	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
)

func TestWidgetVisitorProbeRejectsSubstring(t *testing.T) {
	app := newWidgetUploadTestApp(t)
	for _, test := range []struct {
		message string
		blocked bool
	}{
		{"sig-binding probe, please ignore", true},
		{" \tSIG-BINDING PROBE, PLEASE IGNORE\r\n", true},
		{"i123 sig-binding probe, please ignore", true},
		{"I00017\t sig-binding  probe,\tplease ignore", true},
		{"i47116 probe B - second self-created visitor, please ignore", true},
		{"\tI123 PROBE A\t- FIRST self-created visitor,\tplease ignore ", true},
		{"secprobe-49623-B independent-session", true},
		{"secprobe-00001-z independent-session", true},
		{" \tSECPROBE-27-A\t  INDEPENDENT-SESSION\r\n", true},
		{"", false},
		{" \t\r\n", false},
		{"probe", true},
		{"pRoBe", true},
		{"ignore", false},
		{"sig-binding", false},
		{"请帮我检查页面返回的错误", false},
		{"请问 sig-binding probe, please ignore 是什么意思？", true},
		{"sig-binding probe, please ignore，这是我收到的内容", true},
		{"sig-binding probe,\nplease ignore", true},
		{"i47116 probe B - second self-created visitor, please ignore 这条是我收到的消息", true},
		{"secprobe", true},
		{"secprobe-49623-B independent-session 这是我收到的消息", true},
		{"请问 secprobe-49623-B independent-session 是什么意思？", true},
		{`"secprobe-49623-B independent-session"`, true},
	} {
		t.Run(test.message, func(t *testing.T) {
			req := widgetJSONRequest(app, "{}")
			if blocked := validateWidgetVisitorMessage(req, test.message) != nil; blocked != test.blocked {
				t.Fatalf("guest message rejected=%v, want %v", blocked, test.blocked)
			}
			req.RequestCtx.SetUserValue(ctxWidgetIsVisitor, false)
			if err := validateWidgetVisitorMessage(req, test.message); err != nil {
				t.Fatalf("identified contact's message rejected: %v", err)
			}
		})
	}
}

func TestVisitorProbeRejectedBeforeChatPersistenceOrUpload(t *testing.T) {
	const payload = `{"message":"secprobe-49623-B independent-session","delivery_id":"campaign","browser_key":"browser"}`
	for _, entry := range []string{"initial JSON", "initial multipart", "existing conversation"} {
		t.Run(entry, func(t *testing.T) {
			// Nil user, Redis, conversation and media managers ensure rejection
			// happens before creating a visitor, reading an upload or saving a chat.
			app := newWidgetUploadTestApp(t)
			var req *fastglue.Request
			if entry == "initial multipart" {
				req = widgetMultipartRequest(t, app, []string{payload}, false,
					widgetUploadFile{name: "blocked.exe", contentType: "application/octet-stream", body: []byte("file")})
			} else {
				req = widgetJSONRequest(app, payload)
			}
			handler := handleChatInit
			if entry == "existing conversation" {
				req.RequestCtx.SetUserValue("uuid", "3065587b-1551-4c19-bcb4-8b946538ff5d")
				handler = handleChatSendMessage
			}
			if err := handler(req); err != nil {
				t.Fatal(err)
			}
			if status := req.RequestCtx.Response.StatusCode(); status != fasthttp.StatusBadRequest {
				t.Fatalf("status=%d, want 400; response=%s", status, req.RequestCtx.Response.Body())
			}
			var response struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(req.RequestCtx.Response.Body(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Message != app.i18n.T("globals.messages.errorSendingMessage") {
				t.Fatalf("expected generic message rejection before upload validation, got %q", response.Message)
			}
		})
	}
}

func TestChatInitDecodingPreservesIdentifiedMessagesAndOrdinaryGuestText(t *testing.T) {
	for _, test := range []struct {
		message string
		visitor bool
	}{
		{"sig-binding probe, please ignore", false},
		{"i47116 probe B - second self-created visitor, please ignore", false},
		{"secprobe-49623-B independent-session", false},
		{"请帮我检查页面返回的错误", true},
		{"", true},
	} {
		payload, err := json.Marshal(map[string]string{"message": test.message})
		if err != nil {
			t.Fatal(err)
		}
		for _, multipartBody := range []bool{false, true} {
			app := newWidgetUploadTestApp(t)
			req := widgetJSONRequest(app, string(payload))
			if multipartBody {
				req = widgetMultipartRequest(t, app, []string{string(payload)}, true,
					widgetUploadFile{name: "receipt.txt", contentType: "text/plain", body: []byte("receipt")})
			}
			req.RequestCtx.SetUserValue(ctxWidgetIsVisitor, test.visitor)
			decoded, err := decodeChatInitRequest(req)
			if err != nil {
				t.Fatalf("allowed message rejected: %v", err)
			}
			if decoded.Message != test.message || (multipartBody && len(decoded.Attachments) != 1) {
				t.Fatalf("allowed message or attachment changed: %+v", decoded)
			}
		}
	}
}
