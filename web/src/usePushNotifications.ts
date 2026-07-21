import { useCallback, useEffect, useState } from "react";
import type { BrowserPushSubscription, BrowserToServer, NotificationCapability, ServerToBrowser } from "../../shared/protocol.ts";

type NotificationUpdate = Extract<ServerToBrowser, { type: "notifications.updated" }>;
export type PushNotificationStatus = "loading" | "available" | "enabling" | "enabled" | "denied" | "unavailable" | "error";

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

function serializeSubscription(subscription: PushSubscription): BrowserPushSubscription | undefined {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

export function usePushNotifications({ capability, acknowledgement, connected, connectionId, send }: {
  capability?: NotificationCapability;
  acknowledgement?: NotificationUpdate;
  connected: boolean;
  connectionId: number;
  send: (message: BrowserToServer) => boolean;
}) {
  const [status, setStatus] = useState<PushNotificationStatus>("loading");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (acknowledgement?.error) {
      setStatus("error");
      setError(acknowledgement.error);
    } else if (acknowledgement?.enabled) {
      setStatus("enabled");
      setError(undefined);
    }
  }, [acknowledgement]);

  useEffect(() => {
    let cancelled = false;
    if (!capability) return;
    if (!capability.supported || !capability.vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setStatus("unavailable");
      return;
    }
    void (async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (cancelled) return;
      if (subscription) {
        setStatus("enabled");
        const serialized = serializeSubscription(subscription);
        if (serialized && connected) send({ type: "browser.push_subscribe", subscription: serialized });
      } else {
        setStatus(Notification.permission === "denied" ? "denied" : "available");
      }
    })().catch((reason) => {
      if (cancelled) return;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Unable to inspect notification status");
    });
    return () => { cancelled = true; };
  }, [capability, connected, connectionId, send]);

  const enable = useCallback(async () => {
    if (!capability?.vapidPublicKey || !connected) return;
    setStatus("enabling");
    setError(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "available");
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("Install the PWA before enabling task alerts");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(capability.vapidPublicKey),
      });
      const serialized = serializeSubscription(subscription);
      if (!serialized) throw new Error("The browser returned an invalid push subscription");
      if (!send({ type: "browser.push_subscribe", subscription: serialized })) throw new Error("PISS is disconnected");
      setStatus("enabled");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Unable to enable task alerts");
    }
  }, [capability, connected, send]);

  const disable = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !connected) return;
    setError(undefined);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        send({ type: "browser.push_unsubscribe", endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setStatus("available");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Unable to disable task alerts");
    }
  }, [connected, send]);

  return { status, error, enable, disable };
}
