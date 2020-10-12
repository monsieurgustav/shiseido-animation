module.exports = {
    entry: './src/index.js',
    output: {
        filename: './main.js',
        library: 'Brooch',
        libraryTarget: 'var',
    },
    mode: "development",
    devServer: {
        liveReload: true,
        watchContentBase: true,
        publicPath: '/dist',
    },
};
