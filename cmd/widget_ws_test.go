package main

import (
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/fasthttp/websocket"
	"github.com/valyala/fasthttp"
	"github.com/zerodha/fastglue"
	"github.com/zerodha/logf"
)

func TestWidgetPageURLStripsCredentialsQueryAndHash(t *testing.T) {
	for _, tt := range []struct{ raw, want string }{
		{"https://panel.test/user?token=secret#/login?code=private", "https://panel.test/user"},
		{"https://user:password@panel.test:443/a%2Fb?", "https://panel.test:443/a%2Fb"},
		{"http://panel.test/账单?email=private@example.test", "http://panel.test/%E8%B4%A6%E5%8D%95"},
		{"https://panel.test/", "https://panel.test/"},
		{"javascript:alert(1)", ""},
		{"https:opaque-secret", ""},
		{"/login?token=secret", ""},
		{"https://panel.test/%zz", ""},
	} {
		if got := sanitizeWidgetPageURL(tt.raw); got != tt.want {
			t.Fatalf("sanitize %q: got %q want %q", tt.raw, got, tt.want)
		}
	}
}

func TestWidgetPageHistorySanitizesExistingRedisEntries(t *testing.T) {
	app := newSecureWidgetTestApp(t)
	app.redis.RPush(context.Background(), pageVisitRedisKeyPrefix+"123",
		`{"url":"https://panel.test/user?token=old-secret#private","title":"Account"}`,
		`{"url":"javascript:alert(1)","title":"Invalid"}`)
	pages := getPageVisitsFromRedis(app, 123)
	if len(pages) != 1 || pages[0]["url"] != "https://panel.test/user" || pages[0]["title"] != "Account" {
		t.Fatalf("older history was not sanitized: %v", pages)
	}
}

func TestWidgetWSStopsForwardingAfterRevocationOrLeaseExpiry(t *testing.T) {
	for _, reason := range []string{"logout", "expired"} {
		t.Run(reason, func(t *testing.T) {
			app := newSecureWidgetTestApp(t)
			claims := secureTestClaims("login", "a")
			token, err := exchangeSecureWidgetSession(app, 123, 1, claims)
			if err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			messages := make(chan []byte)
			server := &fasthttp.Server{Handler: func(ctx *fasthttp.RequestCtx) {
				_ = widgetUpgrader.Upgrade(ctx, func(conn *websocket.Conn) {
					sc := &safeConn{conn: conn}
					for msg := range messages {
						if err := sc.writeSessionMessage(app, token, msg); err != nil {
							_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Session ended"), time.Now().Add(time.Second))
							return
						}
					}
				})
			}}
			go server.Serve(listener)
			t.Cleanup(func() { close(messages); server.Shutdown() })
			conn, _, err := websocket.DefaultDialer.Dial("ws://"+listener.Addr().String()+"/widget/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			messages <- []byte(`{"message":"before"}`)
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if _, data, err := conn.ReadMessage(); err != nil || string(data) != `{"message":"before"}` {
				t.Fatalf("initial forwarding failed: %s %v", data, err)
			}
			if reason == "logout" {
				claims.Purpose = "logout"
				if err := revokeSecureWidgetSession(app, 1, claims); err != nil {
					t.Fatal(err)
				}
			} else {
				app.redis.HSet(context.Background(), widgetSessionPrefix+token, "secure_valid_until", time.Now().Add(-time.Second).Unix())
			}
			messages <- []byte(`{"message":"private-after-logout"}`)
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if _, data, err := conn.ReadMessage(); !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
				t.Fatalf("old socket received data after %s: %s %v", reason, data, err)
			}
		})
	}
}

func TestWidgetWSClosesAfterJoinLimit(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lo := logf.New(logf.Opts{})
	app := &App{lo: &lo}
	server := &fasthttp.Server{Handler: func(ctx *fasthttp.RequestCtx) {
		_ = handleWidgetWS(&fastglue.Request{RequestCtx: ctx, Context: app})
	}}
	go server.Serve(listener)
	t.Cleanup(func() { server.Shutdown() })
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+listener.Addr().String()+"/widget/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	join := WidgetMessage{Type: WidgetMsgTypeJoin, Data: json.RawMessage(`[]`)}
	for range wsMaxJoinsPerConn {
		if err := conn.WriteJSON(join); err != nil {
			t.Fatal(err)
		}
		conn.SetReadDeadline(time.Now().Add(time.Second))
		var msg WidgetMessage
		if err := conn.ReadJSON(&msg); err != nil || msg.Type != WidgetMsgTypeError {
			t.Fatalf("expected rejected join, type=%q err=%v", msg.Type, err)
		}
	}
	conn.WriteJSON(join)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("expected policy violation close after join limit, got %v", err)
	}
}
