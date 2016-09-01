var path = require('path')

var secret
try { secret = require('./secret') } catch (err) {}

exports.desktopVersion = '0.13.1'

exports.isProd = process.env.NODE_ENV === 'production'
exports.host = process.env.NODE_ENV === 'production' && '23.92.26.245'

var PORT_80 = process.env.NODE_ENV === 'production' ? 80 : 9000
var PORT_443 = process.env.NODE_ENV === 'production' ? 443 : 9001

exports.ports = {
  router: {
    http: PORT_80,
    https: PORT_443
  },
  web: 9002,
  tracker: 9003,
  whiteboard: 8080, // TEMP
  peerdb: 9200
}

exports.gitterBot = {
  ircChannel: '#webtorrent',
  ircNick: 'irc-gitter-bot',
  ircServer: 'irc.freenode.net',
  gitterRoom: 'feross/webtorrent',
  gitterApiKey: secret && secret.gitterApiKey
}

exports.logPath = process.env.NODE_ENV === 'production'
  ? '/home/feross/www/log/webtorrent.io'
  : path.join(__dirname, 'logs')
