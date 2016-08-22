/**
 * Version.js
 *
 * @description :: TODO: You might write a short summary of how this model works and what it represents here.
 * @docs        :: http://sailsjs.org/documentation/concepts/models-and-orm/models
 */

module.exports = {

  attributes: {

    pki : {

      type : 'integer',
      index : true
    },

    pko : {

      type : 'json'
    },

    version : {

      type : 'integer',
      index : true,
      defaultsTo : 1,
      required : true
    },

    model : {

      type : 'string',
      index : true,
      required : true
    },

    data : {

      type : 'binary',
      required : true
    }
  }
};

