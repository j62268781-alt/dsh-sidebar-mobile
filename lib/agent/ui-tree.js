export async function dumpUiElements(client, deviceId) {
  const data = await client.runJson(["dump", "ui", "--device", deviceId, "--format", "json"]);
  const roots = Array.isArray(data) ? data : (data?.elements ?? []);

  const flat = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    const { children, ...rest } = node;
    flat.push(rest);
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return flat;
}

export function centerOf(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
