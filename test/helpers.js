const _ = require('underscore');
const bolt11 = require('bolt11');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const lnurl = require('../');
const path = require('path');
const querystring = require('querystring');
const secp256k1 = require('secp256k1');
const tmpDir = path.join(__dirname, 'tmp');
const url = require('url');

let ln;

module.exports = {
	lnurl: lnurl,
	tmpDir: tmpDir,
	createServer: function(options) {
		options = _.defaults(options || {}, {
			host: 'localhost',
			port: 3000,
			lightning: {},
			tls: {
				certPath: path.join(tmpDir, 'tls.cert'),
				keyPath: path.join(tmpDir, 'tls.key'),
			},
			store: {
				backend: process.env.LNURL_STORE_BACKEND || 'memory',
				config: (process.env.LNURL_STORE_CONFIG && JSON.parse(process.env.LNURL_STORE_CONFIG)) || {},
			},
		});
		if (ln) {
			if (!options.lightning.backend) {
				options.lightning.backend = ln.backend;
			}
			options.lightning.config = _.defaults(options.lightning.config || {}, ln.config);
		}
		const server = lnurl.createServer(options);
		server.once('listening', () => {
			if (server.options.protocol === 'https') {
				const { certPath } = server.options.tls;
				server.ca = fs.readFileSync(certPath).toString();
			}
		});
		return server;
	},
	prepareMockLightningNode: function(backend, options, done) {
		if (_.isFunction(options)) {
			done = options;
			options = {};
		}
		const mockPath = path.join(__dirname, 'mocks', 'lightning', backend);
		const MockLightningNode = require(mockPath);
		const mockNode = new MockLightningNode(options, done);
		mockNode.backend = backend;
		mockNode.requestCounters = _.chain([
			'getinfo',
			'openchannel',
			'payinvoice',
			'addinvoice',
		]).map(function(key) {
			return [key, 0];
		}).object().value();
		mockNode.resetRequestCounters = function() {
			this.requestCounters = _.mapObject(this.requestCounters, () => {
				return 0;
			});
		};
		mockNode.expectNumRequestsToEqual = function(type, total) {
			if (_.isUndefined(mockNode.requestCounters[type])) {
				throw new Error(`Unknown request type: "${type}"`);
			}
			if (mockNode.requestCounters[type] !== total) {
				throw new Error(`Expected ${total} requests of type: "${type}"`);
			}
		};
		ln = mockNode;
		return mockNode;
	},
	prepareSignedRequest: function(apiKey, tag, params, overrides) {
		overrides = overrides || {};
		const { id, key } = apiKey;
		const nonce = this.generateNonce(12);
		const query = _.extend({
			id: id,
			n: nonce,
			tag: tag,
		}, params, overrides);
		const payload = querystring.stringify(query);
		const signature = lnurl.Server.prototype.createSignature(payload, key);
		query.s = signature;
		return query;
	},
	generateNonce: function(numberOfBytes) {
		return lnurl.Server.prototype.generateRandomKey(numberOfBytes);
	},
	request: function(method, requestOptions, cb) {
		const done = _.once(cb);
		const parsedUrl = url.parse(requestOptions.url);
		let options = _.chain(requestOptions).pick('ca').extend({
			method: method.toUpperCase(),
			hostname: parsedUrl.hostname,
			port: parsedUrl.port,
			path: parsedUrl.path,
		}).value();
		if (requestOptions.qs) {
			options.path += '?' + querystring.stringify(requestOptions.qs);
		}
		const request = parsedUrl.protocol === 'https:' ? https.request : http.request;
		const req = request(options, function(res) {
			let body = '';
			res.on('data', function(buffer) {
				body += buffer.toString();
			});
			res.on('end', function() {
				if (requestOptions.json) {
					try {
						body = JSON.parse(body);
					} catch (error) {
						return done(error);
					}
				}
				done(null, res, body);
			});
		});
		req.once('error', done);
		req.end();
	},
	generatePreImage: function() {
		return lnurl.Server.prototype.generateRandomKey(20);
	},
	generatePaymentRequest: function(amount, extra) {
		extra = extra || {};
		const description = extra.description || null;
		let descriptionHash = extra.descriptionHash || null;
		if (description && !descriptionHash) {
			descriptionHash = lnurl.Server.prototype.hash(Buffer.from(description, 'utf8'));
		}
		const preimage = this.generatePreImage();
		const paymentHash = lnurl.Server.prototype.hash(preimage);
		let tags = [
			{
				tagName: 'payment_hash',
				data: paymentHash,
			},
		];
		if (descriptionHash) {
			tags.push({
				tagName: 'purpose_commit_hash',
				data: descriptionHash,
			});
		} else if (description) {
			tags.push({
				tagName: 'description',
				data: description,
			});
		}
		const encoded = bolt11.encode({
			coinType: 'regtest',
			millisatoshis: amount,
			tags: tags,
		});
		const nodePrivateKey = lnurl.Server.prototype.generateRandomKey();
		const signed = bolt11.sign(encoded, nodePrivateKey);
		return signed.paymentRequest;
	},
	getTagDataFromPaymentRequest: function(pr, tagName) {
		const decoded = bolt11.decode(pr);
		const tag = _.findWhere(decoded.tags, { tagName });
		return tag && tag.data || null;
	},
	generateLinkingKey: function() {
		let privKey;
		do {
			privKey = crypto.randomBytes(32);
		} while (!secp256k1.privateKeyVerify(privKey))
		const pubKey = Buffer.from(secp256k1.publicKeyCreate(privKey));
		return {
			pubKey: pubKey,
			privKey: privKey,
		};
	},
};
