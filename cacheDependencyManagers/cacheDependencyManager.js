'use strict';

var fs = require('fs');
var path = require('path');
var logger = require('../util/logger');
var md5 = require('MD5');
var shell = require('shelljs');
var tar = require('tar-fs');
var gunzip = require('gunzip-maybe');
var zlib = require('zlib');
var rimraf = require('rimraf');


function CacheDependencyManager (config) {
  this.config = config;
}

var getFileHash = function (filePath) {
  var file = fs.readFileSync(filePath);
  return md5(file);
};

// Given a path relative to process' current working directory,
// returns a normalized absolute path
var getAbsolutePath = function (relativePath) {
  return path.resolve(process.cwd(), relativePath);
};

CacheDependencyManager.prototype.cacheLogInfo = function (message) {
  logger.logInfo('[' + this.config.cliName + '] ' + message);
};

CacheDependencyManager.prototype.cacheLogError = function (error) {
  logger.logError('[' + this.config.cliName + '] ' + error);
};


CacheDependencyManager.prototype.installDependencies = function (callback) {
  var installCommand = this.config.installCommand + ' ' + this.config.installOptions;
  installCommand = installCommand.trim();
  this.cacheLogInfo('running [' + installCommand + ']...');
  if (shell.exec(installCommand).code !== 0) {
    this.cacheLogError(error);
    return callback('error running ' + this.config.installCommand);
  } else {
    this.cacheLogInfo('installed ' + this.config.cliName + ' dependencies, now archiving');
  }
  if (this.config.postInstall && typeof this.config.postInstall === 'function') {
    return this.config.postInstall(callback);
  }
  return callback();
};


CacheDependencyManager.prototype.archiveDependencies = function (cacheDirectory, cachePath, hash, callback) {
  var installedDirectory = getAbsolutePath(this.config.installDirectory);
  this.cacheLogInfo('archiving dependencies from ' + installedDirectory);
  fs.writeFile(path.resolve(installedDirectory, 'hash.txt'), hash, function (err) {
    if (err) callback(err);

    // Make sure cache directory is created
    shell.mkdir('-p', cacheDirectory);

    // Now archive installed directory
    
    tar.pack(installedDirectory + '/')
      .pipe(zlib.createGzip())
      .pipe(fs.createWriteStream(cachePath, {
      'defaultEncoding': 'binary'
    })).on('finish', function() {
      console.log("Done!");
      callback();
    });
  });
};

var hashFileIsUpToDate = function (file, hash, callback) {
  fs.readFile(file, function (err, data) {
    if (err) return callback(err);

    if (hash.toString() !== data.toString()) {
      return callback(undefined, false);
    }

    return callback(undefined, true);
  });
};

CacheDependencyManager.prototype.extractDependencies = function (cachePath, hash, callback) {
  var self = this;
  var installedDirectory = getAbsolutePath(self.config.installDirectory);
  var hashFile = path.resolve(installedDirectory, "hash.txt");
  hashFileIsUpToDate(hashFile, hash, function (err, isUpToDate) {
    if (!isUpToDate) {
      self.cacheLogInfo('clearing installed dependencies at ' + installedDirectory);
      rimraf(installedDirectory, function (err) {
        if (err) return callback(err);
        self.cacheLogInfo('...cleared');

        // Make sure install directory is created
        shell.mkdir('-p', installedDirectory);

        self.cacheLogInfo('extracting dependencies from ' + cachePath);

        fs.createReadStream(cachePath, {
          'defaultEncoding': 'binary'
        }).pipe(gunzip())
          .pipe(tar.extract(installedDirectory))
          .on('finish', function() {
            console.log("Done!");
            callback();
          });
      });
      return;
    } else {
      self.cacheLogInfo('dependencies at \'' + installedDirectory + '\' are up to date');
      callback();
      return;
    }
  });
};


CacheDependencyManager.prototype.loadDependencies = function (callback) {
  var self = this;
  var error = null;

  // Check if config file for dependency manager exists
  if (! fs.existsSync(this.config.configPath)) {
    this.cacheLogInfo('Dependency config file ' + this.config.configPath + ' does not exist. Skipping install');
    callback(null);
    return;
  }
  this.cacheLogInfo('config file exists');

  // Check if package manger CLI is installed
  if (! shell.which(this.config.cliName)) {
    error = 'Command line tool ' + this.config.cliName + ' not installed';
    this.cacheLogError(error);
    callback(error);
    return;
  }
  this.cacheLogInfo('cli exists');


  // Get hash of dependency config file
  var hash = getFileHash(this.config.configPath);
  this.cacheLogInfo('hash of ' + this.config.configPath + ': ' + hash);
  // cachePath is absolute path to where local cache of dependencies is located
  var cacheDirectory = path.resolve(this.config.cacheDirectory, this.config.cliName, this.config.getCliVersion());
  var cachePath = path.resolve(cacheDirectory, hash + '.tar.gz');

  // Check if local cache of dependencies exists
  if (! this.config.forceRefresh && fs.existsSync(cachePath)) {
    this.cacheLogInfo('cache exists');

    // Try to extract dependencies
    error = this.extractDependencies(cachePath, hash, function(err) {
      if (!err) {
        // Success!
        self.cacheLogInfo('extracted cached dependencies');
      }
      callback(err);
    });

  } else { // install dependencies with CLI tool and cache

    // Try to install dependencies using package manager
    return this.installDependencies(function (err, res) {
      if (err) return callback(err);
      // Try to archive newly installed dependencies
      this.archiveDependencies(cacheDirectory, cachePath, hash, function(err) {
        if (!err) {
          // Success!
          self.cacheLogInfo('installed and archived dependencies');
        }
        callback(err);
      });
    });
  }
};

/**
 * Looks for available package manager configs in cacheDependencyManagers
 * directory. Returns an object with package manager names as keys
 * and absolute paths to configs as values
 *
 * Ex: {
 *  npm: /usr/local/lib/node_modules/npm-cache/cacheDependencyMangers/npmConfig.js,
 *  bower: /usr/local/lib/node_modules/npm-cache/cacheDependencyMangers/bowerConfig.js
 * }
 *
 * @return {Object} availableManagers
 */
CacheDependencyManager.getAvailableManagers = function () {
  if (CacheDependencyManager.managers === undefined) {
    CacheDependencyManager.managers = {};
    var files = fs.readdirSync(__dirname);
    var managerRegex = /(\S+)Config\.js/;
    files.forEach(
      function addAvailableManager (file) {
        var result = managerRegex.exec(file);
        if (result !== null) {
          var managerName = result[1];
          CacheDependencyManager.managers[managerName] = path.join(__dirname, file);
        }
      }
    );
  }
  return CacheDependencyManager.managers;
};

module.exports = CacheDependencyManager;
