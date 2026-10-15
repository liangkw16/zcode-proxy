const MODELS = [
  { type: "model", id: "GLM-5.3", display_name: "GLM 5.3", created: 0 },
  { type: "model", id: "GLM-5.3-Flash", display_name: "GLM 5.3 Flash", created: 0 },
];

export function handleModels(): Response {
  return Response.json({ object: "list", data: MODELS });
}

export async function handleHealth(auth: {
  getUpstreamHeaders: () => Promise<Record<string, string>>;
}): Promise<Response> {
  try {
    await auth.getUpstreamHeaders();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, message: (error as Error).message }, { status: 503 });
  }
}
