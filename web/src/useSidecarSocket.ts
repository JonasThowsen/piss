import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserToServer, ServerToBrowser } from "../../shared/protocol.ts";

export type ConnectionStatus = "connecting" | "reconnecting" | "online" | "offline";

export function useSidecarSocket(onMessage: (message: ServerToBrowser) => void) {
  const [status, setStatus] = useState<ConnectionStatus>(navigator.onLine ? "connecting" : "offline");
  const [connectionId, setConnectionId] = useState(0);
  const socket = useRef<WebSocket | undefined>(undefined);
  const callback = useRef(onMessage);
  callback.current = onMessage;

  useEffect(() => {
    let stopped = false;
    let hasConnected = false;
    let retry = 250;
    let reconnectTimer: number | undefined;
    let lastReceivedAt = Date.now();
    let lastWakeAt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    const connect = () => {
      clearReconnectTimer();
      if (stopped || document.visibilityState === "hidden") return;
      if (!navigator.onLine) { setStatus("offline"); return; }
      if (socket.current?.readyState === WebSocket.OPEN || socket.current?.readyState === WebSocket.CONNECTING) return;

      setStatus(hasConnected ? "reconnecting" : "connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/api/ws`);
      socket.current = ws;
      ws.onopen = () => {
        if (socket.current !== ws) { ws.close(); return; }
        hasConnected = true;
        retry = 250;
        lastReceivedAt = Date.now();
        setStatus("online");
        setConnectionId((id) => id + 1);
        ws.send(JSON.stringify({ type: "browser.ping" }));
      };
      ws.onmessage = (event) => {
        if (socket.current !== ws) return;
        lastReceivedAt = Date.now();
        try {
          const message = JSON.parse(event.data) as ServerToBrowser;
          if (message.type !== "server.pong") callback.current(message);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        socket.current = undefined;
        if (stopped) return;
        setStatus(navigator.onLine ? "reconnecting" : "offline");
        if (document.visibilityState !== "hidden" && navigator.onLine) {
          reconnectTimer = window.setTimeout(connect, retry);
          retry = Math.min(retry * 2, 5000);
        }
      };
      ws.onerror = () => ws.close();
    };
    const disconnect = () => {
      clearReconnectTimer();
      const current = socket.current;
      socket.current = undefined;
      if (current && current.readyState < WebSocket.CLOSING) current.close(4000, "app suspended");
    };
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastWakeAt < 500) return;
      lastWakeAt = now;
      retry = 250;
      disconnect();
      setStatus(navigator.onLine ? "reconnecting" : "offline");
      connect();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") {
        disconnect();
        setStatus("reconnecting");
      } else {
        wake();
      }
    };
    const wentOffline = () => { disconnect(); setStatus("offline"); };

    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wentOffline);
    connect();
    const heartbeat = window.setInterval(() => {
      const current = socket.current;
      if (current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastReceivedAt > 30_000) {
        current.close(4002, "heartbeat timed out");
        return;
      }
      current.send(JSON.stringify({ type: "browser.ping" }));
    }, 10_000);
    return () => {
      stopped = true;
      clearReconnectTimer();
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wentOffline);
      disconnect();
    };
  }, []);

  const send = useCallback((message: BrowserToServer) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  return { connected: status === "online", status, connectionId, send };
}
