/**
 * Hook dependencies
 */
var
    path = require('path'),
    _ = require('lodash'),
    mergeDefaults = require('merge-defaults'),
    async = require('async'),
    msgpack = require('msgpack');

// Todo: Add readme.
// Todo: Add and clean comments.
// Todo: Write tests.
// Todo: Add an identity attribute to the version model to determine who changed the data, e.g. userid, session etc.
// Todo: Use msgpack or not? Possibility to disable msgpack or use a custom minimizer.
// Todo: Extend sails-hook-events if available and test both modules in combination.
// Todo: Add possibility for a soft delete.
// Todo: Setting to control how many versions will be safed.
// Todo: Disable versioning for some models.
// Todo: Make some settings also available on per model basis.
// Todo: Show available versions of a record.
// Todo: Maybe extend blue prints?
// Todo: Restore many record?? restoreEach method?
// Todo: Test why binary data not work for connection localDiskDb

module.exports = function modelVersioning(sails) {

  var
      config,
      Model,
      isRestore = {};

  // Todo: If some attributes or validations in the model are changed, saved old versions could probably not to be restored. Find a workaround!
  function validRestoreData(model, restoreData) {

    if (_.isUndefined(model) || _.isUndefined(model.primaryKey) || _.isUndefined(model.attributes) || _.isArray(restoreData) || !_.isObject(restoreData)) return false;

    var
        modelAttributes = _.pickBy(model.attributes, function(attr, attrName){

          return attrName!=model.primaryKey && !_.isArray(attr) && _.isObject(attr) && (!_.isUndefined(attr.type) || !_.isUndefined(attr.model));
        }),
        modelKeys = Object.keys(modelAttributes).sort(),
        restoreDataKeys = Object.keys(restoreData).sort();

    return JSON.stringify(modelKeys) === JSON.stringify(restoreDataKeys);
  }

  function getVersion(model, criteria, next) {

    var
        criteria = (_.isObject(criteria) && !_.isArray(criteria)) ? criteria : ((!_.isUndefined(criteria) && !_.isNull(criteria)) ? { pk : criteria } : {}),
        version = !_.isNaN(parseInt(criteria.version)) ? parseInt(criteria.version) : null,
        cb = _.isFunction(next) ? next : function () {},
        pkName = model.primaryKey,
        pkFormat = model.pkFormat,
        pkValue = pkFormat == 'integer' ? (!_.isNaN(parseInt(criteria.pk)) ? parseInt(criteria.pk) : null) : criteria.pk,
        pkInteger = pkFormat == 'integer' ? pkValue : null,
        pkOther = pkFormat != 'integer' ? pkValue : null,
        modelName = model.identity;

    // Try to find last version
    Model.findOne().where({

      pki: pkInteger,
      pko: pkOther,
      version: version,
      model: modelName
    }).exec(function versionInstanceFound(err, versionInstance) {

      // Error handling
      if (err) return cb(err);

      // Callback
      return cb(undefined, versionInstance);
    });
  }

  function getLastVersion(model, pk, next) {

    var
        cb = _.isFunction(next) ? next : function () {},
        pkName = model.primaryKey,
        pkFormat = model.pkFormat,
        pkValue = pkFormat == 'integer' ? (!_.isNaN(parseInt(pk)) ? parseInt(pk) : null) : pk,
        pkInteger = pkFormat == 'integer' ? pkValue : null,
        pkOther = pkFormat != 'integer' ? pkValue : null,
        modelName = model.identity;

    // Try to find last version
    Model.findOne().where({

      pki: pkInteger,
      pko: pkOther,
      model: modelName
    }).sort({ version : 0 }).exec(function lastVersionFound(err, lastVersionInstance) {

      // Error handling
      if (err) return cb(err);

      // Callback
      return cb(undefined, lastVersionInstance);
    });
  }

  function getNextToLastVersion(model, pk, next) {

    var
        cb = _.isFunction(next) ? next : function () {},
        pkName = model.primaryKey,
        pkFormat = model.pkFormat,
        pkValue = pkFormat == 'integer' ? (!_.isNaN(parseInt(pk)) ? parseInt(pk) : null) : pk,
        pkInteger = pkFormat == 'integer' ? pkValue : null,
        pkOther = pkFormat != 'integer' ? pkValue : null,
        modelName = model.identity;

    // First, try to get last version
    getLastVersion(model, pk, function(err, lastVersionInstance){

      // Error handling
      if (err) return cb(err);

      // If last version not found
      if (!lastVersionInstance) return cb();

      // Now try to find version next-to-last
      Model.findOne().where({

        pki: pkInteger,
        pko: pkOther,
        version: { '<' : lastVersionInstance.version },
        model: modelName
      }).sort({ version : 0 }).exec(function nextToLastVersionFound(err, nextToLastVersionInstance) {

        // Error handling
        if (err) return cb(err);

        // Callback
        return cb(undefined, nextToLastVersionInstance);
      });
    });
  }

  function restore(criteria, next) {

    var
        model = this,
        criteria = (_.isObject(criteria) && !_.isArray(criteria)) ? criteria : ((!_.isUndefined(criteria) && !_.isNull(criteria)) ? { pk : criteria } : {}),
        version = !_.isNaN(parseInt(criteria.version)) ? parseInt(criteria.version) : null,
        cb = _.isFunction(next) ? next : function(){},
        pkName = model.primaryKey,
        pkFormat = model.pkFormat,
        pkValue = pkFormat == 'integer' ? (!_.isNaN(parseInt(criteria.pk)) ? parseInt(criteria.pk) : null) : criteria.pk,
        pkInteger = pkFormat == 'integer' ? pkValue : null,
        pkOther = pkFormat != 'integer' ? pkValue : null,
        modelName = model.identity,
        findVersion = version ? getVersion : getNextToLastVersion;

    // Try to find version
    findVersion(model, version ? criteria : pkValue, function versionFound(err, versionInstance){

      // Error handling
      if (err) return cb(err);

      // If version instance found
      if (versionInstance){

        var
            restoreCriteria = {},
            restoreData = config.connection=='localDiskDb' ? versionInstance.data : (_.isBuffer(versionInstance.data) ? msgpack.unpack(versionInstance.data) : false);

        // Error if invalid `restoreData`
        if (!validRestoreData(model, restoreData)) return cb(new Error('Could not restore your '+modelName+' data with the primary key `'+pkValue+'` to version `'+version+'`. The unpacked restore data do not match with your current model attributes.'));

        if (_.isUndefined(isRestore[modelName])){

          isRestore[modelName] = [];
        }
        isRestore[modelName].push(pkValue);

        // Restore criteria to find overwrite record
        restoreCriteria[pkName] = pkFormat=='integer' ? versionInstance.pki : versionInstance.pko;

        // Try to find old data
        sails.models[modelName].findOne(restoreCriteria).exec(function oldDataFound(err, oldDataInstance){

          // Error handling
          if (err) return cb(err);

          // If old data found, destroy them and restore version
          if (oldDataInstance){

            // Destroy old data
            sails.models[modelName].destroy(restoreCriteria).exec(function destroyedOldData(err){

              // Error handling
              if (err) return cb(err);

              // And restore version
              sails.models[modelName].create(mergeDefaults(restoreCriteria, restoreData)).exec(function restoredInstance(err, restoredInstance){

                // Error handling
                if (err) return cb(err);

                // Callback
                return cb(undefined, restoredInstance);
              });
            });
          }
          // If old data not found, only restore version
          else {

            // Restore version
            sails.models[modelName].create(mergeDefaults(restoreCriteria, restoreData)).exec(function restoredInstance(err, restoredInstance){

              // Error handling
              if (err) return cb(err);

              // Callback
              return cb(undefined, restoredInstance);
            });
          }
        });
      }
      // If version not found, do nothing
      else {

        // Callback
        return cb();
      }
    });
  }

  return {

    // Hook defaults
    defaults: {

      __configKey__: {

        model: 'version',
        connection: 'localDiskDb',
        migrate: 'alter',
        autoWatch: false,
        autoSubscribe: false,
        maxVersions: false,
        paths: {

          model: path.resolve(__dirname, 'api/models/model'),
          update: path.resolve(__dirname, 'lib/query/dql/update')
        }
      }
    },

    // Hook configuration
    configure: function(){

      var
          self = this;

      config = sails.config[self.configKey];

      // Only if the orm hook was found
      if (sails.hooks.orm){

        var
            models = sails.hooks.orm.models;

        // Add versioning model to models
        models[config.model] = require(config.paths.model);
        models[config.model].attributes.data.type = config.connection=='localDiskDb' ? 'json' : models[config.model].attributes.data.type;
        models[config.model].connection = config.connection;
        models[config.model].migrate = config.migrate;
        models[config.model].autoWatch = config.autoWatch;
        models[config.model].autosubscribe = config.autoSubscribe;
      }
    },

    // Hook initialization
    initialize: function(cb) {

      var
          self = this;

      // If the orm hook is ready
      sails.on('hook:orm:loaded', function() {

        Model = sails.models[config.model];

        // Versioning events
        var
            versioningEvents = {

              // `afterCreate` versioning event
              afterCreate: function(newlyInsertedRecord, cb){

                var
                    selfChild = this,
                    pkName = selfChild.primaryKey,
                    pkFormat = selfChild.pkFormat,
                    pkValue = pkFormat == 'integer' ? parseInt(newlyInsertedRecord[pkName]) : newlyInsertedRecord[pkName],
                    modelName = selfChild.identity;

                // Reset restore
                if (!_.isUndefined(isRestore[modelName]) && _.includes(isRestore[modelName], pkValue)){

                  isRestore[modelName] = _.pull(isRestore[modelName], pkValue);
                  if (isRestore[modelName].length===0){

                    delete isRestore[modelName];
                  }
                }

                return cb();
              },

              // `beforeUpdate` versioning event
              beforeUpdate: function(valuesToUpdate, criteria, cb){

                var
                    selfChild = this,
                    pkName = selfChild.primaryKey,
                    pkFormat = selfChild.pkFormat,
                    pkvalue = !_.isUndefined(valuesToUpdate[pkName]) ? valuesToUpdate[pkName] : ((!_.isUndefined(criteria.where) && !_.isUndefined(criteria.where[pkName])) ? criteria.where[pkName] : null),
                    pkValue = pkFormat == 'integer' ? parseInt(pkvalue) : pkvalue,
                    modelName = selfChild.identity;

                // Only if it is not a restore
                if (_.isUndefined(isRestore[modelName]) || (!_.isUndefined(isRestore[modelName]) && !_.includes(isRestore[modelName], pkValue))) {

                  if (!_.isUndefined(isRestore[modelName]) && isRestore[modelName].length===0){

                    delete isRestore[modelName];
                  }

                  var
                      pkInteger = pkFormat == 'integer' ? pkValue : null,
                      pkOther = pkFormat != 'integer' ? pkValue : null;

                  // Try to get last version number
                  Model.findOne().where({

                    pki: pkInteger,
                    pko: pkOther
                  }).max('version').exec(function versionCount(err, max) {

                    if (err) new Error(err);

                    var
                        newVersion = (max && !isNaN(parseInt(max.version)) && parseInt(max.version) > 0) ? parseInt(max.version) + 1 : 1;

                    // Only if the first version
                    if (newVersion===1){

                      var
                          oldDataCriteria = {};

                      oldDataCriteria[pkName] = pkFormat=='integer' ? pkInteger : pkOther;

                      // Try to find old data
                      sails.models[modelName].findOne(oldDataCriteria).exec(function oldDataFound(err, oldDataInstance){

                        if (err) new Error(err);

                        if (oldDataInstance){

                          var
                              modelData = _.cloneDeep(oldDataInstance.toObject());

                          // Delete primary key from the model data if set
                          if (!_.isUndefined(modelData[pkName])){

                            delete modelData[pkName];
                          }

                          // Create new version
                          Model.create({

                            pki: pkInteger,
                            pko: pkOther,
                            version: newVersion,
                            model: modelName,
                            data: config.connection=='localDiskDb' ? modelData : msgpack.pack(modelData)
                          }).exec(function versionCreated(err, versionInstance) {

                            if (err) new Error(err);

                            return cb();
                          });
                        }
                        else {

                          sails.log.warn('Could not find the original data to create version `'+version+'` of your '+modelName+' data with the primary key `'+pkValue+'`.');
                          return cb();
                        }
                      });
                    }
                    // Otherwise do nothing
                    else {

                      return cb();
                    }
                  });
                }
                // If it is a restore, do nothing
                else {

                  return cb();
                }
              },

              // `afterUpdate` versioning event
              afterUpdate: function(updatedRecord, cb){

                var
                    selfChild = this,
                    pkName = selfChild.primaryKey,
                    pkFormat = selfChild.pkFormat,
                    pkValue = pkFormat == 'integer' ? parseInt(updatedRecord[pkName]) : updatedRecord[pkName],
                    modelName = selfChild.identity;

                // Only if not a restore
                if (_.isUndefined(isRestore[modelName]) || (!_.isUndefined(isRestore[modelName]) && !_.includes(isRestore[modelName], pkValue))) {

                  if (!_.isUndefined(isRestore[modelName]) && isRestore[modelName].length===0){

                    delete isRestore[modelName];
                  }

                  var
                      pkInteger = pkFormat == 'integer' ? pkValue : null,
                      pkOther = pkFormat != 'integer' ? pkValue : null,
                      modelData = _.cloneDeep(updatedRecord);

                  // Delete primary key from the model data if set
                  if (!_.isUndefined(modelData[pkName])){

                    delete modelData[pkName];
                  }

                  // Try to get last version number
                  Model.findOne().where({

                    pki: pkInteger,
                    pko: pkOther
                  }).max('version').exec(function versionCount(err, max) {

                    if (err) new Error(err);

                    var
                        newVersion = (max && !isNaN(parseInt(max.version)) && parseInt(max.version) > 0) ? parseInt(max.version) + 1 : 1;

                    // Create new version
                    Model.create({

                      pki: pkInteger,
                      pko: pkOther,
                      version: newVersion,
                      model: modelName,
                      data: config.connection=='localDiskDb' ? modelData : msgpack.pack(modelData)
                    }).exec(function versionCreated(err, versionInstance) {

                      if (err) new Error(err);

                      return cb();
                    });
                  });
                }
                else {

                  // Reset restore
                  if (!_.isUndefined(isRestore[modelName]) && _.includes(isRestore[modelName], pkValue)){

                    isRestore[modelName] = _.pull(isRestore[modelName], pkValue);
                    if (isRestore[modelName].length===0){

                      delete isRestore[modelName];
                    }
                  }

                  return cb();
                }
              },

              // `afterDestroy` versioning event
              afterDestroy: function(destroyedRecords, cb) {

                var
                    selfChild = this,
                    pkName = selfChild.primaryKey,
                    pkFormat = selfChild.pkFormat,
                    modelName = selfChild.identity;

                if (_.isArray(destroyedRecords)) {

                  // Versioning each destroyed record
                  async.forEach(Object.keys(destroyedRecords), function (index, aCb) {

                    var
                        destroyedRecord = destroyedRecords[index],
                        pkValue = pkFormat == 'integer' ? parseInt(destroyedRecord[pkName]) : destroyedRecord[pkName],
                        pkInteger = pkFormat == 'integer' ? pkValue : null,
                        pkOther = pkFormat != 'integer' ? pkValue : null,
                        modelData = _.cloneDeep(destroyedRecord);

                    // Only if not a restore
                    if (_.isUndefined(isRestore[modelName]) || (!_.isUndefined(isRestore[modelName]) && !_.includes(isRestore[modelName], pkValue))) {

                      if (!_.isUndefined(isRestore[modelName]) && isRestore[modelName].length === 0) {

                        delete isRestore[modelName];
                      }

                      // Delete primary key from the model data if set
                      if (!_.isUndefined(modelData[pkName])) {

                        delete modelData[pkName];
                      }

                      // Try to get last version number
                      Model.findOne().where({

                        pki: pkInteger,
                        pko: pkOther
                      }).max('version').exec(function versionCount(err, max) {

                        if (err) new Error(err);

                        var
                            newVersion = (max && !isNaN(parseInt(max.version)) && parseInt(max.version) > 0) ? parseInt(max.version) + 1 : 1;

                        // Create new version
                        Model.create({

                          pki: pkInteger,
                          pko: pkOther,
                          version: newVersion,
                          model: modelName,
                          data: config.connection=='localDiskDb' ? modelData : msgpack.pack(modelData)
                        }).exec(function versionCreated(err, versionInstance) {

                          if (err) new Error(err);

                          aCb();
                        });
                      });
                    }
                    // Otherwise do nothing
                    else {

                      aCb();
                    }
                  }, function () {

                    return cb();
                  });
                }
                else {

                  throw new Error('Unexpected data in `afterDestroy` callback. Expected an array for `destroyedRecords`.');
                  return cb();
                }
              }
            };

        // Loop through all models
        for (var model in sails.models) {

          // If it is not the versioning model and if we found the callbacks
          if (model!=config.model && !_.isUndefined(sails.models[model]._callbacks)) {

            // Extend the model with the versioning events
            for (var event in versioningEvents) {

              var
                  versioningEvent = versioningEvents[event];

              if (!_.isUndefined(sails.models[model]._callbacks[event])){

                sails.models[model]._callbacks[event].push(versioningEvent);
              }
            }

            // Replace each default update method with a patched update method because we can not access the criteria in `beforeUpdate` (see: https://github.com/balderdashy/waterline/pull/1328)
            sails.models[model].update = require(config.paths.update);

            // Add a restore method to each model
            sails.models[model].restore = restore;
          }
        }

        // Initialized
        return cb();
      });
    }
  };
}
