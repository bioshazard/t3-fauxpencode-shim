import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const noBroadObjectParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Reject broad object parameters; name the input contract.",
    },
    messages: {
      broadObject:
        "Use a named input type instead of the broad `object` parameter type.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Function) => {
      for (const parameter of node.params) {
        if (
          parameter.type === "Identifier" &&
          parameter.typeAnnotation?.typeAnnotation.type === "TSObjectKeyword"
        ) {
          context.report({ node: parameter, messageId: "broadObject" });
        }
      }
    };

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});

const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Reject ad hoc typeof checks outside an input decoder.",
    },
    messages: {
      runtimeTypeof:
        "Decode external values at the boundary instead of branching on `typeof`.",
    },
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});

/** Small local ruleset that keeps the POC's boundaries explicit and typed. */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-object-parameters": noBroadObjectParametersRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
  },
});

export default antiSlopPlugin;
