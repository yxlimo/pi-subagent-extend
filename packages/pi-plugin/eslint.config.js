// Lint for bug classes a type checker does not catch.
//
// This config is deliberately not a style preset: every rule here exists because
// the mistake was actually made in this repository. A broad preset (js.configs
// .recommended, say) buries them in 147 no-undef findings about node globals that
// nobody reads, and a lint nobody reads is not a lint.

import tseslint from "typescript-eslint"
import unicorn from "eslint-plugin-unicorn"

export default tseslint.config(
  { ignores: ["bin/**", "node_modules/**", "../helper/target/**"] },
  {
    files: ["**/*.ts", "**/*.mts", "**/*.mjs", "**/*.js"],
    languageOptions: { parser: tseslint.parser },
    plugins: { unicorn },
    rules: {
      // `await f(x)?.y` is `await (f(x)?.y)`: optional chaining binds tighter than
      // await, so `.y` is read from the *Promise*, which is undefined, and the awaited
      // value is undefined rather than the resolved result. It shipped twice in this
      // repository's tests, each time making an assertion pass for the wrong reason.
      // The chain node is what makes this precise: a plain `await a?.b` is not flagged.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'AwaitExpression > ChainExpression > MemberExpression[optional=true][object.type="CallExpression"]',
          message:
            "`await f(x)?.y` reads the property off the Promise; it is `await (f(x)?.y)`. Write `(await f(x))?.y`, or bind the result first.",
        },
      ],

      // The complement: `(await f()).x` is correct but is one edit away from the bug
      // above, and nothing about it reads as a precedence question. Binding the result
      // to a name first removes the ambiguity for the next reader.
      "unicorn/no-await-expression-member": "error",
    },
  },
)
