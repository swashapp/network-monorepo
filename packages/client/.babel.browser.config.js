module.exports = {
    presets: [
        ['@babel/preset-env', {
            useBuiltIns: 'usage',
            corejs: 3,
            bugfixes: true,
            shippedProposals: true,
            targets: {
                browsers: [
                    'supports async-functions',
                    'supports cryptography',
                    'supports es6',
                    'supports es6-generators',
                    'not dead',
                    'not ie <= 11',
                    'not ie_mob <= 11'
                ]
            },
            exclude: ['transform-regenerator', '@babel/plugin-transform-regenerator']
        }],
        ['@babel/preset-typescript']
    ],
    plugins: [
        'transform-typescript-metadata',
         ["@babel/plugin-proposal-decorators", { "legacy": true }],
        'lodash',
         'add-module-exports',
        ['@babel/plugin-transform-runtime', {
            corejs: 3,
            helpers: true,
            regenerator: false
        }],
         "@babel/plugin-transform-modules-commonjs",
        ['@babel/plugin-proposal-class-properties', {
            loose: false
        }]
    ]
}
