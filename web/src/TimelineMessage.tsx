import React from "react";
import { compactText, imageAttachments, textContent, type PiMessage } from "./message-content.ts";

function ToolResult({ message }: { message: PiMessage }) {
  const text = textContent(message.content);
  const images = imageAttachments(message.content);
  const toolName = message.toolName ?? "tool";
  const lines = text ? text.split("\n").length : 0;
  const changed = toolName === "edit" || toolName === "write";
  const status = message.isError ? "ERROR" : changed ? "CHANGED" : "DONE";
  const preview = compactText(text, 110) || (images.length ? `${images.length} image result${images.length === 1 ? "" : "s"}` : "No textual output");

  return <details className={`tool-result ${message.isError ? "error" : ""} ${changed ? "changed" : ""}`}>
    <summary>
      <i />
      <b>{toolName}</b>
      <span>{preview}</span>
      {lines > 1 && <em>{lines}L</em>}
      <small>{status}</small>
      <strong aria-hidden="true">+</strong>
    </summary>
    <div className="tool-result-body">
      {text && <pre>{text}</pre>}
      {images.length > 0 && <div className="tool-result-images">{images.map((image, index) => <span key={`${image.mimeType}-${index}`}>▧ IMAGE <small>{image.mimeType.replace("image/", "").toUpperCase()}</small></span>)}</div>}
    </div>
  </details>;
}

export function TimelineMessage({ message, live }: { message: PiMessage; live?: boolean }) {
  const role = message.role ?? "event";
  if (role === "toolResult") return <ToolResult message={message} />;
  const text = textContent(message.content);
  const images = imageAttachments(message.content);
  if (!text && images.length === 0) return null;
  return <article className={`message ${role} ${live ? "live" : ""}`}>
    <header><span>{role === "assistant" ? "PI" : role === "user" ? "REMOTE" : role.toUpperCase()}</span>{live && <i>STREAMING</i>}</header>
    {text && <div>{text}</div>}
    {images.length > 0 && <div className="message-attachments">{images.map((image, index) => <span key={`${image.mimeType}-${index}`}>▧ IMAGE ATTACHED <small>{image.mimeType.replace("image/", "").toUpperCase()}</small></span>)}</div>}
  </article>;
}
