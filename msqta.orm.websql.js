MSQTA._ORM.WebSQL = {
	
	Schema: function( schemaDefinition ) {
		return MSQTA._Helpers.instantiateSchema( { 
			ORM: this.constructor._ORM,
			schemaPrototype: MSQTA._Schema.WebSQL,
			schemaDefinition: schemaDefinition,
			implementation: 'webSQL',
			args: arguments
		} );
	},
	
	_open: function() {
		// put in a close to handle various open at "the same time"
		(function( self ) {
			self._testigoDB = window.openDatabase( '__msqta__', 1, '', MSQTA._Helpers.webSQLSize );
			self._testigoDB.transaction( function( tx ) {
				tx.executeSql( 'CREATE TABLE IF NOT EXISTS databases( id INTEGER PRIMARY KEY, name TEXT UNIQUE, schemas TEXT )' );
				tx.executeSql( 'SELECT * FROM databases WHERE name = "' + self._name + '"', [], function( tx, results ) {
					self._open2( results );
				} );
			} );
		})( this );
	},
	
	_open2: function( results ) {
		var rows = results.rows;
		// store here all the schemaKeepTrack definitions
		this._schemasDefinition = rows.length ? JSON.parse( rows.item( 0 ).schemas ) : {};
		
		// this holds queries to be run when a sql fails
		// this is used when the multiples queries are connected
		// but they cannot be runs all in a single transaction
		this._errorQueries = [];
		// this holds all the interal queries that are made when
		// a schema is initialized, these queries are more important
		// that this._queries in terms at the moment of execute the next query
		this._queriesInternal = [];
		
		this._userDB = window.openDatabase( this._name, 1, '', MSQTA._Helpers.webSQLSize );

		if( this._initCallback ) {
			this._initCallback.call( this.initContext || window );
		}
		
		this._initSchemas();
	},

	_initSchema: function( Schema ) {
		this._schemasToInit.push( Schema );
		if( !this._isBlocked ) {
			this._initSchemas();
		}
	},
	
	_initSchemas: function() {
		var self = this,
			databaseName = this._name;
		
		if( this._schemasToInit.length ) {
			this._schemasToInit.shift()._init2();
			
		} else {
			this._endSchemasInitialization();
		}
	},
	
	_endSchemasInitialization: function() {
		this._isBlocked = false;
	},
	
	_saveSchemaOnTestigoDatabase: function( callback, context ) {
		var self = this,
			databaseName = this._name,
			schemasDefinition = this._schemasDefinition;
		
		if( this.devMode ) {
			console.log( 'MSQTA-ORM: saving schema definition in the testigo database to keep tracking future changes on it' );
		}
		
		this._testigoDB.transaction( function( tx ) {
			tx.executeSql( 'REPLACE INTO databases( name, schemas ) VALUES( "' + databaseName + '", ' + "'" + JSON.stringify( schemasDefinition ) + "'" + ')', [], function() {
				callback.call( context );
			} );
		} );
	},
	
	_deleteUserDatabase: function( callback, context ) {
		this.destroy( callback, context );
	},
	
	_deleteUserSchema: function( Schema, queryData ) {
		var schemaName = Schema._name;
		
		delete this._Schemas[schemaName];
		MSQTA._Helpers.dimSchemaInstance( Schema );
	
		this._saveSchemaOnTestigoDatabase( queryData.userCallback, queryData.userContext );
	},
	
	/**
	* @context SQLTransaction
	*/
	_error: function( error ) {
		console.error( 'MSQTA-ORM: query has failed: \n\t' + 'code: ' + error.code + '\n\t' + 'message: ' + error.message );
		// continue with more shit
		this._results( false );
	},
/***************************************/
	_transaction: function( queryData ) {
		var callback = queryData.userCallback,
			context = queryData.userContext;
		
		if( callback && typeof callback !== 'function' ) {
			throw Error( 'MSQTA-ORM: supplied callback is not a function: ', callback );
		}
		// use default callback
		if( !callback ) {
			queryData.userCallback = MSQTA._Helpers.defaultCallback;
		}
		
		if( context && typeof context !== 'object' ) {
			throw Error( 'MSQTA-ORM: supplied context is not an object: ', context );
		}
		// use window as context
		if( !context ) {
			queryData.userContext = window;
		}

		// only allow a query per time
		if( this._isWaiting ) {
			if( queryData.isInternal ) {
				this._queriesInternal.push( queryData );
			} else {
				this._queries.push( queryData );
			}
			return;
		}
		this._isWaiting = true;
		
		this._transaction2( queryData );
	},
	
	_transaction2: function( queryData ) {
		// save a refenrece for when the transaction is done
		this._lastQuery = queryData;
		
		// save a reference used in the success and error functions
		var self = this,
			query = queryData.query;
		
		if( !( query instanceof Array ) ) {
			query = [ query ];
		}
		
		var success = function( tx, results ) {
			self._results( results );
		};
		
		var error = function( tx, error ) {
			self._error( error );
		};
		
		this._userDB.transaction( function( tx ) {			
			var q,
				l = query.length;

			while( l-- ) {
				q = query.shift();
				if( self.devMode ) {
					console.log( 'MSQTA-ORM: executing the query: \n\t' + q );
				}
				tx.executeSql( q, [], !l ? success : MSQTA._Helpers.noop, error );
			}
		} );
	},
	
	/**
	* @context SQLTransaction
	*/
	_results: function( results ) {
		queryData = this._lastQuery;
		
		this._isWaiting = false;
		// comes from _error()
		if( !results ) {
			results = false;
		}
		
		// still more processing (only select clauses falls here)
		if( queryData.callback && queryData.context ) {
			// go to the original caller
			queryData.callback.call( queryData.context, results, queryData );
			
		// get back with the user
		} else {
			// only delete, update, insert quries falls here
			queryData.userCallback.call( queryData.userContext, queryData.isInsert ? results.insertId : results.rowsAffected );
		}
		
		this._continue();
	},
	
	_continue: function() {
		if( !this._isWaiting ) {
			// more queries to be executed in the queue
			if( this._queriesInternal.length ) {
				this._transaction( this._queriesInternal.shift() );
			} else if( this._queries.length ) {
				this._transaction( this._queries.shift() );
			}
		}
	},
/***************************************/
/***************************************/
	batch: function( data, callback, context ) {
		var databaseName = this._name,
			batchData;
		
		if( !( data instanceof Array ) || !data.length ) {
			MSQTA._Errors.batch1( databaseName, data );
		}
		
		if( typeof callback !== 'function' ) {
			callback = MSQTA._Helpers.defaultCallback;
		}
		if( typeof context !== 'object' ) {
			context = window;
		}
		// agrup arguments for a better manipulation
		batchData = {
			data: data,
			callback: callback,
			context: context
		};
		
		if( this._isBatchMode ) {
			this._batchsStack.push( batchData );
			return;
		}
		// start batch mode, this means that the methods set, put and del
		// will not execute the query, instead them will be return the querty string
		this._isBatchMode = true;
		
		this._batch( batchData );
	},
	
	_batch: function( batchData ) {
		var data = batchData.data,
			typeValids = [ 'set', 'put', 'del' ],
			queryData, Schema, type,
			i = 0, l = data.length;
		
		for( ; i < l; i++ ) {
			queryData = data[i];
			Schema = queryData.schema;
			if( !( Schema instanceof MSQTA._Schema ) ) {
				MSQTA._Errors.batch2( Schema );
			}
			type = queryData.type.toLowerCase();
			if( typeValids.indexOf( type ) === -1 ) {
				MSQTA._Errors.batch3( type );
			}
			// save the queries
			this._queries = this._queries.concat( { query: Schema[type]( queryData.data ) } );
		}
		// the last one will the return point
		var t = this._queries[this._queries.length-1];
		t.callback = batchData.callback;
		t.context = batchData.context;
		
		this._isBatchMode = false;
		
		// exec the queries
		this._continue();

		// this happends when batch is called when another
		// batch process is running
		if( this._batchsStack.length ) {
			this._batch( this._batchsStack.shift() );
		}
	},
/***************************************/
/***************************************/
	destroy: function( callback, context ) {
		if( typeof callback !== 'function' ) {
			callback = MSQTA._Helpers.noop;
		}
		
		console.error( 'MSQTA: destroy: deleting a database is not implemented in webSQL standard and will never do.\n To delete a database you need to do manually.' );
		
		callback.call( context || window );
	},
/***************************************/
/***************************************/
	_addQueryError: function( query ) {
		this._errorQueries.push( query );
		return this._errorQueries.length-0;
	},
	
	_removeQueryError: function( id ) {
		this._errorQueries.splice( id, 1 );
	}
};