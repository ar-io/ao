const path = require('path');
const fs = require('fs');

const walletPath = process.env.PATH_TO_WALLET;
let walletKey = JSON.parse(fs.readFileSync(path.resolve(walletPath), 'utf8'));

let config = {
    muWallet: walletKey,
    sequencerUrl: 'https://gw.warp.cc'
};

module.exports = config;