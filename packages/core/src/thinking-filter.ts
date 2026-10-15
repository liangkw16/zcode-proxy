export function stripThinkingFromMessage<T extends { content?: any[] } | null>(message: T): T {
  if (!message || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.filter((block) => block?.type !== "thinking"),
  };
}
