import { createPraxisWebMcpTools } from "./tools";
import type {
  MaybePromise,
  PraxisWebMcpHost,
  PraxisWebMcpRegistration,
  PraxisWebMcpToolName,
  RegisterPraxisWebMcpOptions,
  WebMcpDocumentLike,
  WebMcpModelContext,
  WebMcpToolDefinition,
  WebMcpToolTeardown,
} from "./types";

function defaultDocument(): WebMcpDocumentLike | undefined {
  return typeof document === "undefined"
    ? undefined
    : (document as unknown as WebMcpDocumentLike);
}

export function getDocumentModelContext(
  documentLike: WebMcpDocumentLike | null | undefined = defaultDocument(),
): WebMcpModelContext | undefined {
  const candidate = documentLike?.modelContext;

  if (!candidate || typeof candidate.registerTool !== "function") {
    return undefined;
  }

  return candidate;
}

export function isWebMcpAvailable(
  documentLike: WebMcpDocumentLike | null | undefined = defaultDocument(),
): boolean {
  return getDocumentModelContext(documentLike) !== undefined;
}

function invokeTeardown(teardown: WebMcpToolTeardown): MaybePromise<void> {
  return typeof teardown === "function" ? teardown() : teardown.unregister();
}

function isTeardown(value: unknown): value is WebMcpToolTeardown {
  return (
    typeof value === "function" ||
    (typeof value === "object" &&
      value !== null &&
      "unregister" in value &&
      typeof (value as { unregister?: unknown }).unregister === "function")
  );
}

function legacyContextTeardown(
  modelContext: WebMcpModelContext,
  tool: WebMcpToolDefinition,
): WebMcpToolTeardown | undefined {
  if (!modelContext.unregisterTool) {
    return undefined;
  }

  return async () => {
    // Historical shims have accepted either the definition or its name. Both
    // calls are bounded and cleanup errors are intentionally non-fatal.
    try {
      await modelContext.unregisterTool?.(tool);
    } catch {
      // Try the name form below.
    }

    try {
      await modelContext.unregisterTool?.(tool.name);
    } catch {
      // The first form may already have removed the tool.
    }
  };
}

async function registerTool(
  modelContext: WebMcpModelContext,
  tool: WebMcpToolDefinition,
  signal: AbortSignal,
): Promise<void | WebMcpToolTeardown> {
  try {
    return await modelContext.registerTool(tool, { signal });
  } catch (error) {
    // Early shims sometimes reject an options argument instead of ignoring it.
    // Current implementations use DOMException for registration failures, so a
    // TypeError is the only compatibility case retried with one argument.
    if (!(error instanceof TypeError) || signal.aborted) {
      throw error;
    }

    return await modelContext.registerTool(tool);
  }
}

function createRegistration(
  supported: boolean,
  controller: AbortController,
  registeredToolNames: readonly PraxisWebMcpToolName[],
  unavailableReason?: "model_context_unavailable",
): PraxisWebMcpRegistration {
  return {
    supported,
    registeredToolNames,
    signal: controller.signal,
    ...(unavailableReason ? { unavailableReason } : {}),
    dispose(reason?: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(
          reason ?? new DOMException("Praxis WebMCP tools were disposed.", "AbortError"),
        );
      }
    },
  };
}

/**
 * Registers the project-scoped Praxis catalog. Missing WebMCP support is a
 * normal feature-detection result, not an exception.
 */
export async function registerPraxisWebMcpTools(
  host: PraxisWebMcpHost,
  options: RegisterPraxisWebMcpOptions = {},
): Promise<PraxisWebMcpRegistration> {
  const controller = new AbortController();
  const registeredToolNames: PraxisWebMcpToolName[] = [];

  const hasExplicitModelContext = Object.prototype.hasOwnProperty.call(options, "modelContext");
  const modelContext = hasExplicitModelContext
    ? getDocumentModelContext(
        options.modelContext ? { modelContext: options.modelContext } : null,
      )
    : getDocumentModelContext();

  if (!modelContext) {
    return createRegistration(
      false,
      controller,
      registeredToolNames,
      "model_context_unavailable",
    );
  }

  const legacyTeardowns: WebMcpToolTeardown[] = [];
  const runLegacyTeardowns = () => {
    for (const teardown of legacyTeardowns.splice(0).reverse()) {
      void Promise.resolve()
        .then(() => invokeTeardown(teardown))
        .catch(() => undefined);
    }
  };

  controller.signal.addEventListener("abort", runLegacyTeardowns, { once: true });

  if (options.signal) {
    const disposeFromParent = () => controller.abort(options.signal?.reason);

    if (options.signal.aborted) {
      disposeFromParent();
    } else {
      options.signal.addEventListener("abort", disposeFromParent, { once: true });
      controller.signal.addEventListener(
        "abort",
        () => options.signal?.removeEventListener("abort", disposeFromParent),
        { once: true },
      );
    }
  }

  if (controller.signal.aborted) {
    return createRegistration(true, controller, registeredToolNames);
  }

  const requestedToolNames = options.toolNames
    ? new Set<PraxisWebMcpToolName>(options.toolNames)
    : undefined;
  const tools = createPraxisWebMcpTools(host, controller.signal)
    .filter((tool) => requestedToolNames?.has(tool.name) ?? true);

  try {
    for (const tool of tools) {
      const teardown = await registerTool(modelContext, tool, controller.signal);
      if (isTeardown(teardown)) {
        if (controller.signal.aborted) {
          await invokeTeardown(teardown);
        } else {
          legacyTeardowns.push(teardown);
        }
      } else {
        const contextTeardown = legacyContextTeardown(modelContext, tool);
        if (contextTeardown) {
          legacyTeardowns.push(contextTeardown);
        }
      }
      registeredToolNames.push(tool.name);
    }
  } catch (error) {
    controller.abort(
      new DOMException("Praxis WebMCP tool registration failed.", "AbortError"),
    );
    throw error;
  }

  return createRegistration(true, controller, registeredToolNames);
}
