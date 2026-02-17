import { checkBrowserOrigin } from "../../origin-check.js";
import {
  type ConnectParams,
  formatValidationErrors,
  validateConnectParams,
  validateRequestFrame,
} from "../../protocol/index.js";

export type FrameMeta = {
  type?: string;
  method?: string;
  id?: string;
};

export type ConnectRequestFrame = {
  type: "req";
  id: string;
  method: "connect";
  params: ConnectParams;
};

export type ConnectFrameValidation =
  | {
      ok: true;
      frame: ConnectRequestFrame;
      connectParams: ConnectParams;
      frameMeta: FrameMeta;
      isRequestFrame: true;
    }
  | {
      ok: false;
      frameMeta: FrameMeta;
      isRequestFrame: boolean;
      requestId?: string;
      errorMessage: string;
    };

export type ProtocolValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      errorMessage: "protocol mismatch";
      expectedProtocol: number;
      minProtocol: number;
      maxProtocol: number;
    };

export type RoleScopeValidation =
  | {
      ok: true;
      role: "operator" | "node";
      scopes: string[];
    }
  | {
      ok: false;
      roleRaw: string;
      errorMessage: "invalid role";
    };

export type OriginValidation =
  | {
      ok: true;
    }
  | {
      ok: false;
      errorMessage: string;
      reason?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function extractFrameMeta(parsed: unknown): FrameMeta {
  const obj = asRecord(parsed);
  if (!obj) {
    return {};
  }
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const method = typeof obj.method === "string" ? obj.method : undefined;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  return { type, method, id };
}

export function validateConnectHandshakeFrame(parsed: unknown): ConnectFrameValidation {
  const frameMeta = extractFrameMeta(parsed);
  const isRequestFrame = validateRequestFrame(parsed);

  if (!isRequestFrame) {
    return {
      ok: false,
      frameMeta,
      isRequestFrame: false,
      errorMessage: "invalid request frame",
    };
  }

  const requestFrame = parsed as {
    id: string;
    method: string;
    params: unknown;
  };

  if (requestFrame.method !== "connect") {
    return {
      ok: false,
      frameMeta,
      isRequestFrame: true,
      requestId: requestFrame.id,
      errorMessage: "invalid handshake: first request must be connect",
    };
  }

  if (!validateConnectParams(requestFrame.params)) {
    return {
      ok: false,
      frameMeta,
      isRequestFrame: true,
      requestId: requestFrame.id,
      errorMessage: `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`,
    };
  }

  const frame: ConnectRequestFrame = {
    type: "req",
    id: requestFrame.id,
    method: "connect",
    params: requestFrame.params,
  };

  return {
    ok: true,
    frame,
    connectParams: requestFrame.params,
    frameMeta,
    isRequestFrame: true,
  };
}

export function validateProtocolCompatibility(
  connectParams: ConnectParams,
  protocolVersion: number,
): ProtocolValidation {
  const { minProtocol, maxProtocol } = connectParams;
  if (maxProtocol < protocolVersion || minProtocol > protocolVersion) {
    return {
      ok: false,
      errorMessage: "protocol mismatch",
      expectedProtocol: protocolVersion,
      minProtocol,
      maxProtocol,
    };
  }
  return { ok: true };
}

export function validateRoleAndScopes(connectParams: ConnectParams): RoleScopeValidation {
  const roleRaw = connectParams.role ?? "operator";
  const role = roleRaw === "operator" || roleRaw === "node" ? roleRaw : null;
  if (!role) {
    return {
      ok: false,
      roleRaw,
      errorMessage: "invalid role",
    };
  }

  const requestedScopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
  const scopes =
    requestedScopes.length > 0 ? requestedScopes : role === "operator" ? ["operator.admin"] : [];

  return {
    ok: true,
    role,
    scopes,
  };
}

export function validateBrowserOrigin(params: {
  requestHost?: string;
  requestOrigin?: string;
  allowedOrigins?: string[];
  isControlUi: boolean;
  isWebchat: boolean;
}): OriginValidation {
  const { requestHost, requestOrigin, allowedOrigins, isControlUi, isWebchat } = params;
  if (!isControlUi && !isWebchat) {
    return { ok: true };
  }

  const originCheck = checkBrowserOrigin({
    requestHost,
    origin: requestOrigin,
    allowedOrigins,
  });

  if (originCheck.ok) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: originCheck.reason,
    errorMessage:
      "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)",
  };
}
