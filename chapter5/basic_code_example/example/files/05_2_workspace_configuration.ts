const WORKSPACE: string =
  process.env.ARTCRAFT_WORKSPACE ??
  path.join(os.tmpdir(), "artcraft-bridge");
