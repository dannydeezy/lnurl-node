const _ = require('underscore');
const async = require('async');
const knex = require('knex');
const debug = {
	error: require('debug')('lnurl:store:knex:error'),
};

let Store = function(options) {
	this.options = options || {};
	this.db = knex(this.options);
	this.prepareQueues();
	this.prepareTable().then(() => {
		this.resumeQueue('onReady');
	}).catch(error => {
		this.resumeQueue('onReady', error);
	});
};

Store.prototype.prepareQueues = function() {
	this.queueError = {};
	this.queues = {
		onReady: async.queue((task, next) => {
			const error = this.queueError.onReady || null;
			if (error) {
				task.reject(error);
			} else {
				task.resolve();
			}
			next();
		}, 1/* concurrency */),
	};
	// Pause all queues to delay execution of tasks until later.
	_.invoke(this.queues, 'pause');
};

Store.prototype.resumeQueue = function(name, error) {
	if (error) {
		this.queueError[name] = error;
	}
	this.queues[name].resume();
};

Store.prototype.onReady = function() {
	if (Array.from(arguments).length > 0) {
		throw new Error('Store.onReady takes no arguments');
	}
	return new Promise((resolve, reject) => {
		this.queues.onReady.push({ resolve, reject });
	});
};

Store.prototype.prepareTable = function() {
	return this.db.schema.hasTable('urls').then(exists => {
		if (!exists) {
			return this.db.schema.createTable('urls', table => {
				table.string('hash').unique();
				table.json('data');
			});
		}
	});
};

Store.prototype.save = function(hash, data) {
	return this.onReady().then(() => {
		data = JSON.stringify(data);
		return this.exists(hash).then(exists => {
			if (exists) {
				return this.db('urls').update({ data }).where('hash', hash);
			}
			return this.db.insert({ hash, data }).into('urls');
		});
	});
};

Store.prototype.exists = function(hash) {
	return this.fetch(hash).then(data => {
		return !!data;
	});
};

Store.prototype.fetch = function(hash) {
	return this.onReady().then(() => {
		return this.db.select('*').from('urls').where('hash', hash).then(result => {
			let data;
			let row = result[0] || null;
			if (row) {
				if (_.isString(row.data)) {
					data = JSON.parse(row.data);
				} else {
					data = row.data;
				}
			}
			return data || null;
		});
	});
};

Store.prototype.delete = function(hash) {
	return this.onReady().then(() => {
		return this.db.del().from('urls').where('hash', hash);
	});
};

Store.prototype.close = function() {
	return new Promise((resolve, reject) => {
		this.db.destroy(error => {
			if (error) return reject(error);
			resolve();
		});
	});
};

module.exports = Store;
