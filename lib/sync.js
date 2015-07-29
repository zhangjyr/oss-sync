var fs = require('fs');
var path = require('path');

var Promise = require('bluebird');
var rm = Promise.promisify(require('rimraf'));
var chalk = require('chalk');
var mkdir = Promise.promisify(fs.mkdir);
var debug = require('debug')('sync:sync');

var Git = require('./git');
var OSS = require('./oss');
var trash = require('./trash');
var parse = require('./parse');

exports = module.exports = Sync;

function Sync(options) {
  if (!(this instanceof Sync)) {
    return new Sync(options);
  }

  var basePath = process.cwd();

  this.source = path.resolve(basePath, options.source);
  this.dest = options.dest[0] == '/'
    ? options.dest.substr(1)
    : options.dest;

  this.repo = new Git(path.join(this.source, '.sync'));
  this.oss = new OSS(options, this.source, this.dest);

  this.forceUpload = !!options.forceUpload;
  this.incrementalMode = !!options.incrementalMode;

}

Sync.prototype.exec = function () {
  var self = this;
  var repo = self.repo;
  var source = self.source;
  var oss = self.oss;
  var forceUpload = self.forceUpload;
  var incrementalMode = self.incrementalMode;

  var syncPath = path.join(source, '.sync');
  var trashPath = path.join(source, '.sync', 'trash');

  var isDirty = fs.existsSync(path.join(source, '.sync'));

  var start = Date.now();
  var profiler = function(message, promise) {
        var last = Date.now();
        promise.then(function() {
            var end = Date.now();
            console.log(chalk.grey("  " + message + " takes: " + (end - last) + "ms of " + (end - start) + "ms"));
        });
        return promise;
  }

  return profiler("Initialization(init)", init())
    .then(function () {
      return profiler("Queue generation(qgen)", generateQueue());
    })
    .spread(function (putList, deleteList) {
      return profiler("Queue processing(qproc)", handleQueue(putList, deleteList));
    })
    .then(function () {
      debug('Sync complete!');
    }, function (err) {
      debug('Error occurred!');
      debug(err);
      console.log(err.stack);
      return Promise.reject(err);
    })

  // Init .sync folder to save trash and git status
  // and generate trash
  function init() {
    return Promise.resolve()
      .then(function () {
        debug('Sync init');
        if (forceUpload) {
          return rm(syncPath).then(function () {
            return mkdir(syncPath)
          })
        }
        if (isDirty) {
          if (incrementalMode) {
            return
          } else {
            return rm(trashPath)
          }
        }
        return mkdir(syncPath)
      })
      .then(function () {
        return repo.init()
      })
      .then(function () {
        return profiler(
          "init - file comparison",
          trash(source, {
            modified: incrementalMode,
            clobber: !incrementalMode
          })
        );
      })
  }

  // Use git status to generate operation queue
  function generateQueue() {
    return repo.add()
      .then(function () {
        return profiler("qgen - git status", repo.status());
      })
      .then(function (status) {
        var queue = parse(status);
        debug('OSS operation queue:');
        debug(queue);
        return [queue.put, queue.delete]
      })
  }

  // Upload and delete objects
  function handleQueue(putList, deleteList) {
    return Promise.resolve()
      .then(function () {
        return profiler("qproc - oss uploading", oss.putMultiObjects(putList));
      })
      .then(function () {
        return profiler("qproc - oss deletion", oss.deleteMultiObjects(deleteList));
      })
      // All complete and git commit
      .then(function () {
        return profiler("qproc - git commit", repo.commit());
      })
  }
}
