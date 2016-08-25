var compress = require('compression')
var cors = require('cors')
var debug = require('debug')('webtorrent-www:web')
var downgrade = require('downgrade')
var express = require('express')
var highlight = require('highlight.js')
var http = require('http')
var path = require('path')
var pug = require('pug')
var Remarkable = require('remarkable')
var unlimited = require('unlimited')
var url = require('url')

var config = require('../config')
var desktopApi = require('./desktop-api')

unlimited()

var app = express()
var server = http.createServer(app)

var remark = new Remarkable({
  html: true,
  highlight: function (code, lang) {
    var h = lang
      ? highlight.highlight(lang, code)
      : highlight.highlightAuto(code)
    return '<div class="hljs">' + h.value + '</div>'
  }
})

pug.filters.markdown = (md, options) => {
  return remark.render(md)
}

app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'pug')
app.set('x-powered-by', false)
app.engine('pug', pug.renderFile)

// Pretty print JSON
app.set('json spaces', 2)

// Trust the X-Forwarded-* headers from http-proxy
app.enable('trust proxy')

// Use GZIP
app.use(compress())

// Use SSL
app.use(function (req, res, next) {
  // Force SSL
  if (config.isProd && req.protocol !== 'https') {
    return res.redirect('https://' + (req.hostname || 'webtorrent.io') + req.url)
  }

  // Redirect www to non-www
  if (config.isProd && req.hostname === 'www.webtorrent.io') {
    return res.redirect('https://webtorrent.io' + req.url)
  }

  // Use HTTP Strict Transport Security
  // Lasts 1 year, incl. subdomains, allow browser preload list
  if (config.isProd) {
    res.header(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    )
  }

  // Add cross-domain header for fonts, required by spec, Firefox, and IE.
  var extname = path.extname(url.parse(req.url).pathname)
  if (['.eot', '.ttf', '.otf', '.woff'].indexOf(extname) >= 0) {
    res.header('Access-Control-Allow-Origin', '*')
  }

  // Prevents IE and Chrome from MIME-sniffing a response. Reduces exposure to
  // drive-by download attacks on sites serving user uploaded content.
  res.header('X-Content-Type-Options', 'nosniff')

  // Prevent rendering of site within a frame.
  res.header('X-Frame-Options', 'DENY')

  // Enable the XSS filter built into most recent web browsers. It's usually
  // enabled by default anyway, so role of this headers is to re-enable for this
  // particular website if it was disabled by the user.
  res.header('X-XSS-Protection', '1; mode=block')

  // Force IE to use latest rendering engine or Chrome Frame
  res.header('X-UA-Compatible', 'IE=Edge,chrome=1')

  next()
})

// Serve the Webtorrent Desktop REST API
desktopApi.serve(app)

// Serve the demo torrent (Sintel)
// Enable CORS preflight, and cache it for 1 hour. This is necessary to support
// requests from another domain with the "Range" HTTP header.
app.options('/torrents/*', cors({ maxAge: 60 * 60 }))

app.get('/torrents/*', cors(), express.static(path.join(__dirname, '../static')))

// Serve static resources
app.use(express.static(path.join(__dirname, '../static')))

// Serve all the pug pages
app.get('/', function (req, res) {
  res.render('home', { rawTitle: 'WebTorrent - Streaming browser torrent client' })
})

app.get('/desktop', function (req, res) {
  res.render('desktop', {
    cls: 'desktop',
    rawTitle: 'WebTorrent Desktop',
    version: config.desktopVersion
  })
})

app.get('/intro', function (req, res) {
  res.render('intro', { rawTitle: 'WebTorrent Tutorial - Get Started' })
})

app.get('/docs', function (req, res) {
  res.render('docs', { rawTitle: 'WebTorrent API Documentation' })
})

app.get('/faq', function (req, res) {
  res.render('faq', { rawTitle: 'WebTorrent FAQ' })
})

app.get('/create', function (req, res) {
  res.render('create', { title: 'Create a .torrent file' })
})

app.get('/logs', function (req, res) {
  res.redirect(301, 'https://botbot.me/freenode/webtorrent/')
})

// Handle errors (404 for unrecognized URLs, 500 for uncaught errors)
app.get('*', function (req, res) {
  res.status(404).render('error', {
    title: '404 Not Found',
    message: '404 Not Found'
  })
})

app.use(function (err, req, res, next) {
  console.error(err.stack)
  res.status(500).render('error', {
    title: '500 Server Error',
    message: '500 Server Error'
  })
})

// Listen on port 443 (in production), then drop root privileges and start serving requests
server.listen(config.ports.web, function () {
  debug('listening on port ' + server.address().port)
  downgrade()
  process.send('ready')
})
