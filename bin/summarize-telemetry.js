#!/usr/bin/env node

var get = require('simple-get')
var config = require('../config')
var path = require('path')
var fs = require('fs')
var semver = require('semver')

var TELEMETRY_PATH = path.join(config.logPath, 'telemetry')

main()

function main () {
  // Find all files in the telemetry folder...
  fs.readdir(TELEMETRY_PATH, function (err, files) {
    if (err) die(err)

    // Filter down to just log files...
    var logFiles = files
      .filter((f) => /\d{4}-\d{2}-\d{2}.log/.test(f))
      .sort()

    var summary = {}
    // Read them all and collect summary stats...
    loadTelemetrySummary(logFiles).then(function (telemetry) {
      summary.telemetry = telemetry
      // Load WebTorrent Desktop release history from Github...
      return loadReleases()
    }).then(function (releases) {
      summary.releases = releases
      summary.totalInstalls = releases
        .map((r) => r.installs)
        .reduce(function (a, b) {
          a.win32 += b.win32
          a.linux += b.linux
          a.darwin += b.darwin
          a.total += b.total
          return a
        }, { win32: 0, linux: 0, darwin: 0, total: 0 })

      // Finally, write summary.json
      var summaryPath = path.join(TELEMETRY_PATH, 'summary.json')
      var summaryJSON = JSON.stringify(summary, null, 2) // pretty print
      fs.writeFile(summaryPath, summaryJSON, function (err) {
        if (err) die(err)
        console.log('Done!')
      })
    }).catch(die)
  })
}

function die (err) {
  console.error(err)
  process.exit(1)
}

// Reads telemetry log files in parallel, then produces a summary array, one
// entry for each day: [{date, actives, retention, ...}, ...]
function loadTelemetrySummary (logFiles) {
  console.log('Summarizing ' + logFiles.length + ' telemetry log files')
  return Promise.all(logFiles.map(function (filename) {
    return new Promise(function (resolve, reject) {
      // Read each telemetry log file, one per day...
      var filePath = path.join(TELEMETRY_PATH, filename)
      fs.readFile(filePath, 'utf8', function (err, json) {
        if (err) return reject(err)

        // Each log file contains one JSON record per line
        try {
          var lines = json.trim().split('\n')
          var records = lines.map(JSON.parse)
        } catch (err) {
          return reject(err)
        }
        console.log('Read ' + records.length + ' rows from ' + filename)
        resolve(summarizeDailyTelemetryLog(filename, records))
      })
    })
  })).then(combineDailyTelemetrySummaries)
}

// Summarize a potentially huge (GB+) log file down to a few KB...
function summarizeDailyTelemetryLog (filename, records) {
  var uniqueUsers = {}
  var sessions = { total: 0, errored: 0, byVersion: {} }
  var errors = {}
  var versionByUser = {}

  records.forEach(function (record) {
    // Filter out *very* rare empty records that only have {ip}
    if (!record.system) return

    // Count unique users
    var version = (record.version || 'pre-0.12')
    var platform = record.system.osPlatform
    uniqueUsers[record.userID] = true
    versionByUser[record.userID] = {version, platform}

    // Approximate sessions by # of telemetry reports
    sessions.total++
    var byV = sessions.byVersion[version]
    if (!byV) byV = sessions.byVersion[version] = { total: 0, errored: 0 }
    byV.total++

    // Summarize uncaught errors
    var errs = record.uncaughtErrors
    if (!errs || errs.length === 0) return
    sessions.errored++
    byV.errored++

    errs.forEach(function (err) {
      var key = err.message ? err.message.substring(0, 30) : '<missing error message>'

      // Before 0.13, we didn't log the app version for each uncaught error
      // Before 0.12, we didn't log the app version altogether, and also
      // didn't redact stacktraces.
      var errVersion = err.version
         ? err.version
         : err.stack.includes('app.asar') ? 'pre-0.12' : version

      // 1. Either update the stats for an existing error...
      var error = errors[key]
      if (error) {
        error.count++
        addToSet(platform, error.platforms)
        addToSet(err.process, error.processes)
        addToSet(errVersion, error.versions, function (a, b) {
          if (a === 'pre-0.12') return b === 'pre-0.12' ? 0 : -1
          if (b === 'pre-0.12') return 1
          return semver.compare(a, b)
        })

        // Use the message and stack from the latest possible version
        if (errVersion === error.versions[error.versions.length - 1]) {
          error.message = err.message
          error.stack = err.stack
        }

        return
      }

      // 2. ...or create a new error
      errors[key] = {
        key: key,
        message: err.message,
        stack: err.stack,
        count: 1,
        versions: [errVersion],
        platforms: [platform],
        processes: [err.process]
      }
    })
  })

  // Summarize usage by app version and OS
  var usage = {
    version: {},
    platform: {},
    versionPlatform: {}
  }
  for (var uid in versionByUser) {
    var v = versionByUser[uid]
    var vp = v.version + '-' + v.platform
    usage.version[v.version] = (usage.version[v.version] || 0) + 1
    usage.platform[v.platform] = (usage.platform[v.platform] || 0) + 1
    usage.versionPlatform[vp] = (usage.versionPlatform[vp] || 0) + 1
  }

  return {
    date: filename.substring(0, 10), // YYYY-MM-DD
    sessions,
    uniqueUsers,
    errors,
    usage
  }
}

// Adds an element to an array if it doesn't exist yet, the sorts the array
function addToSet (elem, arr, sortFn) {
  if (arr.includes(elem)) return
  arr.push(elem)
  arr.sort(sortFn)
}

// Combine all the per-day summaries into a single summary...
function combineDailyTelemetrySummaries (days) {
  var uniqueUsers = {} // Running set, all unique users so far
  var newUsersByDay = [] // First-time users each day

  // Loop thru all days since we started collecting telemetry...
  return days.map(function (day, i) {
    // Sanity check: we should have consecutive days, correctly sorted
    if (i > 0) {
      var delta = new Date(day.date).getTime() -
                  new Date(days[i - 1].date).getTime()
      var deltaDays = delta / 24 / 3600 / 1000
      if (deltaDays !== 1) throw new Error('Missing telemetry before ' + day.date)
    }

    // Find out who installed the app that day
    var newUsers = {}
    Object.keys(day.uniqueUsers).forEach(function (user) {
      if (uniqueUsers[user]) return
      uniqueUsers[user] = true
      newUsers[user] = true
    })
    var numInstalls = Object.keys(newUsers).length
    newUsersByDay[i] = newUsers

    var errors = Object.keys(day.errors)
      .map((key) => day.errors[key])
      .sort((a, b) => b.count - a.count)

    return {
      date: day.date,
      actives: {
        today: computeActives(days, i, 1),
        last7: computeActives(days, i, 7),
        last30: computeActives(days, i, 30)
      },
      installs: numInstalls,
      retention: {
        day1: i < 2 ? null : computeRetention(days, i, 1, newUsersByDay[i - 1]),
        day7: i < 8 ? null : computeRetention(days, i, 1, newUsersByDay[i - 7]),
        day28: i < 29 ? null : computeRetention(days, i, 1, newUsersByDay[i - 28]),
        day30to60: i < 61 ? null : computeRetention(days, i, 30, newUsersByDay[i - 60])
      },
      usage: day.usage,
      errorRates: {
        last7: computeErrorRate(days, i, 7),
        today: computeErrorRate(days, i, 1),
        'today-latest': computeErrorRate(days, i, 1, true),
        'last7-latest': computeErrorRate(days, i, 7, true)
      },
      errors
    }
  })
}

// Finds the fraction of telemetry reports that contain an error
function computeErrorRate (days, index, n, latestVersionOnly) {
  if (index < n - 1) return null
  var total = 0
  var errored = 0
  for (var i = index - n + 1; i <= index; i++) {
    var day = days[i]

    // Use either *all* sessions from that UTC day, or only those sessions
    // which were at the latest released version as of the end of the day
    var sessions
    if (latestVersionOnly) {
      var latest = '0.12.0'
      Object.keys(day.usage.version).forEach(function (version) {
        if (version === 'pre-0.12') return
        if (semver.gt(version, latest)) latest = version
      })
      sessions = day.sessions.byVersion[latest] || { total: 0, errored: 0 }
    } else {
      sessions = day.sessions
    }

    total += sessions.total
    errored += sessions.errored
  }

  return total ? (errored / total) : null
}

// Finds the number of unique active users over the last n days
// ending with days[index]. Returns null if index < n - 1
function computeActives (days, index, n) {
  if (index < n - 1) return null
  var combined = {}
  for (var i = index - n + 1; i <= index; i++) {
    Object.assign(combined, days[i].uniqueUsers)
  }
  return Object.keys(combined).length
}

// Computes retention: the # of new users from some past day that used the
// app on this day.
function computeRetention (days, index, n, prevNewUsers) {
  var uniques = {}
  for (var i = index - n + 1; i <= index; i++) {
    Object.assign(uniques, days[i].uniqueUsers)
  }

  var numToday = Object.keys(uniques).length
  Object.assign(uniques, prevNewUsers)
  var numCombined = Object.keys(uniques).length
  var numPrev = Object.keys(prevNewUsers).length
  var numLost = numCombined - numToday
  return (numPrev - numLost) / numPrev
}

// Loads all WebTorrent Desktop releases
// Callback: (err, [{tag_name, published_at}, ...])
function loadReleases (cb) {
  var opts = {
    url: 'https://api.github.com/repos/feross/webtorrent-desktop/releases',
    json: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Safari/537.36'
    }
  }

  return new Promise(function (resolve, reject) {
    console.log('Fetching ' + opts.url)
    get.concat(opts, function (err, res, data) {
      if (err) return reject(err)
      console.log('Got ' + data.length + ' WebTorrent Desktop releases')
      var releases = data.map(function (d) {
        // Count total downloads
        var win32 = 0
        var darwin = 0
        var linux = 0
        d.assets.map(function (a) {
          if (a.name.endsWith('.dmg')) {
            darwin += a.download_count
          } else if (a.name.endsWith('.exe')) {
            win32 += a.download_count
          } else if (a.name.endsWith('.deb') ||
                     a.name.endsWith('linux-ia32.zip') ||
                     a.name.endsWith('linux-x64.zip')) {
            linux += a.download_count
          }
        })
        var total = win32 + darwin + linux
        var installs = {win32, darwin, linux, total}

        return {tag_name: d.tag_name, published_at: d.published_at, installs}
      })
      resolve(releases)
    })
  })
}
