// Mantine's Vite setup recipe (docs/web.md §1): postcss-preset-mantine plus postcss-simple-vars
// defining the mantine-breakpoint-* variables its components expect.
// eslint-disable-next-line no-undef -- CommonJS config file; `module` is a Node global.
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
};
