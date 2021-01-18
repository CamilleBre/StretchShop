"use strict";

const { MoleculerClientError } = require("moleculer").Errors;
const Cron = require("moleculer-cron");

const DbService = require("../mixins/db.mixin");
const CacheCleanerMixin = require("../mixins/cache.cleaner.mixin");
const HelpersMixin = require("../mixins/helpers.mixin");

module.exports = {
	name: "subscriptions",
	mixins: [
		DbService("subscriptions"),
		CacheCleanerMixin([
			"cache.clean.subscriptions"
		]),
		Cron,
		HelpersMixin
	],

	crons: [{
		name: "SubscriptionsCleaner",
		cronTime: "0 0 * * *",
		onTick: function() {

			this.logger.info("Starting to Clean up the Subscriptions");

			this.getLocalService("subscriptions")
				.actions.runSubscriptions()
				.then((data) => {
					this.logger.info("Subscriptions runned", data);
				});
		}
	}],

	/**
	 * Default settings
	 */
	settings: {
		/** Public fields */
		fields: ["_id", "userId", "ip", "type", "period", "duration", "cycles", "status", "orderOriginId", "orderItemName", "dates", "price", "data", "history"],

		/** Validator schema for entity */
		entityValidator: {
			userId: { type: "string", min: 3 },
			ip: { type: "string", min: 4 },
			period: {type: "string", min: 3 }, // year, month, week, day, ...
			duration: {type: "number", positive: true }, // 1, 3, 9.5, ...
			cycles: {type: "number"}, // number of repeats, for infinity use 0 and less
			status: { type: "string", min: 3 }, // inactive, active, finished, ...
			orderOriginId: { type: "string", min: 3 },
			orderItemName: { type: "string", min: 3 },
			dates: { type: "object", props: {
				dateStart: { type: "date" },
				dateOrderNext: { type: "date" },
				dateEnd: { type: "date" },
				dateCreated: { type: "date" },
				dateUpdated: { type: "date" },
			}},
			price: { type: "number" },
			data: { type: "object", props:
				{
					product: { type: "object" },
					order: { type: "object", optional: true },
					remoteData: { type: "object", optional: true }
				}
			},
			history: { type: "array", optional: true, items:
				{ type: "object", props: {
					action: { type: "string" }, // created, prolonged, stopped, paused, ...
					type: { type: "string" }, // user, automatic, ...
					date: { type: "date" },
					data: { type: "object", optional: true }
				} }
			}
		}
	},


	/**
	 * Actions
	 */
	actions: {

		/**
		 * disable cache for find action
		 */
		find: {
			cache: false
		},


		/**
		 * Get currently active user's subscriptions
		 *
		 * @actions
		 *
		 * @returns {Object} User entity
		 */
		listSubscriptions: {
			cache: false,
			auth: "required",
			// cache: {
			// 	keys: ["dates.dateUpdated"],
			// 	ttl: 30
			// },
			params: {
				query: { type: "object", optional: true },
				limit: { type: "number", optional: true },
				offset: { type: "number", optional: true },
				sort: { type: "string", optional: true },
				fullData: { type: "boolean", optional: true }
			},
			handler(ctx) {
				let self = this;

				if ( ctx.meta.user && ctx.meta.user._id ) {
					let filter = { query: {}, limit: 20};
					if (typeof ctx.params.query !== "undefined" && ctx.params.query) {
						filter.query = ctx.params.query;
					}
					// update filter acording to user
					if ( ctx.meta.user.type=="admin" && typeof ctx.params.fullData!=="undefined" && ctx.params.fullData==true ) {
						// admin can browse all orders
					} else {
						filter.query["userId"] = ctx.meta.user._id.toString();
					}
					// set offset
					if (ctx.params.offset && ctx.params.offset>0) {
						filter.offset = ctx.params.offset;
					}
					// set max of results
					if (typeof ctx.params.limit !== "undefined" && ctx.params.limit) {
						filter.limit = ctx.params.limit;
					}
					if (filter.limit>20) {
						filter.limit = 20;
					}
					// sort
					filter.sort = "-dates.dateCreated";
					if (typeof ctx.params.sort !== "undefined" && ctx.params.sort) {
						filter.sort = ctx.params.sort;
					}

					if ( filter.query && filter.query._id && filter.query._id.trim()!="" ) {
						filter.query._id = this.fixStringToId(filter.query._id);
						filter.limit = 1;
					}

					return ctx.call("subscriptions.find", filter)
						.then(found => {
							this.logger.info("subscriptions listSubscriptions found:", found);
							if (found && found.constructor===Array ) {
								return self.transformDocuments(ctx, {}, found);
							} else {
								return self.Promise.reject(new MoleculerClientError("Subscriptions not found!", 400));
							}
						})
						.then(subscriptions => {
							// delete history for user
							if (filter.limit>1) {
								subscriptions.forEach(s => {
									delete s.history;
								});
							}
							return subscriptions;
							// return self.transformEntity(subscriptions, true, ctx);
						})
						.catch((error) => {
							self.logger.error("subscriptions.me error", error);
							return null;
						});
				}

			}
		},


		/**
		 * Converts order with subscription items to subscription records
		 * 
		 * @actions
		 * 
		 * @param {Object} - order object to get subscriptions from
		 * 
		 * @returns {Object} 
		 */
		orderToSubscription: {
			// auth: "required",
			cache: false,
			params: {
				order: { type: "object" }
			},
			handler(ctx) {
				// 1. get subscription items from order
				const subscriptions = this.getOrderSubscriptions(ctx.params.order);
				let promises = [];
				let self = this;
				
				// 2. create subscription for every subscribe item
				if (subscriptions && subscriptions.length>0) {
					for (let i=0; i<subscriptions.length; i++) {
						let subscription = this.createEmptySubscription();
						// 3. get subscription order
						let order = this.prepareOrderForSubscription(ctx.params.order, subscriptions[i]);

						subscription.data.product = subscriptions[i];
						subscription.data.order = order;
						// fill in data from product - period & duration & cycles
						if (subscriptions[i].data && subscriptions[i].data.subscription) {
							if (subscriptions[i].data.subscription.period) {
								subscription.period = subscriptions[i].data.subscription.period;
							}
							if (subscriptions[i].data.subscription.duration) {
								subscription.duration = subscriptions[i].data.subscription.duration;
							}
							if (subscriptions[i].data.subscription.cycles) {
								subscription.cycles = subscriptions[i].data.subscription.cycles;
							}
						}
						// basics
						subscription.userId = order.user.id;
						subscription.ip = ctx.meta.remoteAddress+":"+ctx.meta.remotePort;
						// this is just for development debuging needs
						if (ctx.params.order._id["$oid"]) {
							ctx.params.order._id = ctx.params.order._id["$oid"];
						}
						subscription.orderOriginId = ctx.params.order._id.toString();
						subscription.orderItemName = subscriptions[i].name[order.lang.code];
						subscription.dates.dateStart = new Date();
						/* dateOrderNext set to now, because first payment is done 
						   right after customer accepts agreement to billing plan */
						subscription.dates.dateOrderNext = new Date();
						subscription.price = subscriptions[i].price;

						subscription.history.push( 
							this.newHistoryRecord("created", "user", {
								type: "from order",
								relatedOrder: ctx.params.order._id.toString()
							}) 
						);

						// setting up date when subscription ends
						let dateEnd = this.calculateDateEnd(
							subscription.dates.dateStart,
							subscription.period,
							subscription.duration,
							subscription.cycles
						);
						subscription.dates.dateEnd = dateEnd;
						this.logger.info("subscriptions.orderToSubscription subscription 2 save:", subscription);

						// 4. save subscription
						promises.push(
							ctx.call("subscriptions.save", {entity: subscription} )
								.then((saved) => {
									this.logger.info("subscriptions.orderToSubscription - added subscription["+i+"]: ", saved);
									return saved;
								})); // push with save end
					}
				}

				// return multiple promises results
				return Promise.all(promises).then(savedSubscriptions => {
					this.logger.info("subscriptions.orderToSubscription Promise.all(promises):", promises);
					// save IDs into related order
					let subscrIds = [];
					let productSubscriptions = {};
					savedSubscriptions.forEach(function(sasu){
						// get ID or subscription and related product
						subscrIds.push({
							subscription: sasu._id.toString(),
							product: sasu.data.product._id.toString()
						});
						productSubscriptions[sasu.data.product._id.toString()] = sasu._id.toString();
					});
					if ( !ctx.params.order.data.subscription ) {
						ctx.params.order.data["subscription"] = {
							created: new Date(),
							ids: []
						};
					}
					ctx.params.order.data.subscription.ids = subscrIds;
					// add subscription ID also into product in order list
					for (let i=0; i<ctx.params.order.items.length; i++) {
						ctx.params.order.items[i].subscriptionId = productSubscriptions[ctx.params.order.items[i]._id.toString()];
					}
					this.logger.info("subscriptions.orderToSubscription Promise.all(promises) subscrIds:", subscrIds);
					// add ID parameter
					ctx.params.order.id = ctx.params.order._id;
					// saving ids into related order
					return ctx.call("orders.update", {
						order: Object.assign({}, ctx.params.order)
					})
						.then(order => {
							// save IDs
							return savedSubscriptions;
						});
				});
			}
		},


		/**
		 * CRON action (see crons.cronTime setting for time to process):
		 *  1. find all subscriptions that need to processed
		 *  2. create and process new order for these subscriptions
		 *  3. update subscriptions
		 * 
		 * to debug you can use - mol $ call subscriptions.runSubscriptions
		 * 
		 * @actions
		 */
		runSubscriptions: {
			cache: false,
			handler(ctx) {
				let self = this;
				let promises = [];
				const today = new Date();
				
				// get dateOrder for today and less
				return this.adapter.find({
					query: {
						"dates.dateOrderNext": { "$lte": today },
						"dates.dateEnd": { "$gte": today },
						status: "active"
					}
				})
					.then(found => {
						this.logger.info("subsp found ", found);
						found.forEach(subscription => {
							let newOrder = Object.assign({}, subscription.data.order);
							promises.push( 
								ctx.call("orders.create", {order: newOrder} )
									.then(orderResult => {
										this.logger.info("subscriptions.service runSubscriptions orderResult: ", JSON.stringify(orderResult));
										let dateEnd = new Date(subscription.dates.dateEnd);
										if ( dateEnd > today ) {
											// set new value for dateOrderNext
											subscription.dates.dateOrderNext = this.calculateDateOrderNext(
												subscription.period,
												subscription.duration
											);
										} else {
											subscription.status = "finished";
										}
										subscription.history.push( 
											{
												action: "prolonged",
												type: "automatic",
												date: new Date(),
												relatedOrder: orderResult._id.toString()
											} 
										);
										return self.adapter.updateById(subscription._id, this.prepareForUpdate(subscription))
											.then(subscriptionUpdated => {
												return subscriptionUpdated;
											});
									})
							);
						});
						// return all runned subscriptions
						return Promise.all(promises).then((result) => {
							return result;
						});
					});
			}
		},


		/**
		 * Import subscriptions data:
		 *
		 * @actions
		 * 
		 * @param {Array} - array of subscription to import
		 *
		 * @returns {Object} Category entity
		 */
		import: {
			auth: "required",
			params: {
				subscriptions: { type: "array", items: "object", optional: true },
			},
			// cache: {
			// 	keys: ["#subscriptionID"]
			// },
			handler(ctx) {
				this.logger.info("subscriptions.import - ctx.meta");
				let subscriptions = ctx.params.subscriptions;
				let promises = [];

				if (ctx.meta.user.type=="admin") {
					if ( subscriptions && subscriptions.length>0 ) {
						// loop products to import
						subscriptions.forEach(function(entity) {
							promises.push(
								// add subscription results into result variable
								ctx.call("subscriptions.save", {entity})
							); // push with find end
						});
					}

					// return multiple promises results
					return Promise.all(promises).then(prom => {
						return prom;
					});
				} else { // not admin user
					return Promise.reject(new MoleculerClientError("Permission denied", 403, "", []));
				}	
			}
		},


		/**
		 * Save subscription:
		 *  - if no ID, create new;
		 *  - if has ID, update;
		 * 
		 * @actions
		 * 
		 * @param {Object} entity - entity to save, must contain ".id" parameter for identification
		 *
		 * @returns {Object} subscription entity with items
		 */
		save: {
			cache: false,
			params: {
				entity: { type: "object" } // su
			},
			handler(ctx) {
				let self = this;
				let entity = ctx.params.entity;

				return this.adapter.findById(entity.id)
					.then(found => {
						if (found) { // entity found, update it
							if ( entity ) {
								if ( entity.dates ) {
									// convert strings to Dates
									Object.keys(entity.dates).forEach(function(key) {
										let date = entity.dates[key];
										if ( date && date!=null && !(date instanceof Date) && 
										date.toString().trim()!="" ) {
											entity.dates[key] = new Date(entity.dates[key]);
										}
									});
								}
							}

							return self.validateEntity(entity)
								.then(() => {
									if (!entity.dates) {
										entity.dates = {};
									}
									entity.dates.dateUpdated = new Date();
									entity.dates.dateSynced = new Date();
									self.logger.info("subscription.save found - update entity:", entity);
									let entityId = entity.id;
									delete entity.id;
									delete entity._id;
									const update = {
										"$set": entity
									};

									return self.adapter.updateById(entityId, update)
										.then(doc => self.transformDocuments(ctx, {}, doc))
										.then(json => self.entityChanged("updated", json, ctx).then(() => json));
								})
								.catch(error => {
									self.logger.error("subscriptions.save update validation error: ", error);
								});
						} else { // no product found, create one
							return self.validateEntity(entity)
								.then(() => {
									// check if user doesn't have same subscription in that time
									return ctx.call("subscriptions.find", {
										"query": {
											userId: entity.userId,
											orderItemName: entity.orderItemName,
											status: "active"
											// "dates.dateStart": {"$le": entity.dates.dateStart} // TODO - set date range
										}
									})
										.then(entityFound => {
											if (entityFound && entityFound.constructor === Array && 
											entityFound.length>0) {
												self.logger.warn("subscriptions.save - insert - found similar entity:", entityFound);
											}
											if (!entity.dates) {
												entity.dates = {};
											}
											// convert strings to Dates
											Object.keys(entity.dates).forEach(function(key) {
												let date = entity.dates[key];
												if ( date && date!=null && !(date instanceof Date) && 
												date.toString().trim()!="" ) {
													entity.dates[key] = new Date(entity.dates[key]);
												}
											});
											self.logger.info("subscriptions.save - insert entity:", entity);

											return self.adapter.insert(entity)
												.then(doc => self.transformDocuments(ctx, {}, doc))
												.then(json => self.entityChanged("created", json, ctx).then(() => json));
										});
								})
								.catch(err => {
									self.logger.error("subscriptions.save insert validation error: ", err);
								});
						} // else end
					})
					.catch(err => {
						self.logger.error("subscriptions.save findById error: ", err);
					});
			}
		},


		/**
		 * Save subscription:
		 *  - if no ID, create new;
		 *  - if has ID, update;
		 * 
		 * @actions
		 * 
		 * @param {Object} updateObject - subscription entity to update, with data to update, must contain ".id" parameter for identification
		 *
		 * @returns {Object} updated subscription entity
		 */
		update: {
			cache: false,
			params: {
				updateObject: { type: "object" },
				historyRecordToAdd: { type: "object", optional: true }
			},
			handler(ctx) {
				let self = this;

				return this.adapter.findById(ctx.params.updateObject.id)
					.then(found => {
						if (found) {
							let original = Object.assign({}, found);
							original.data = JSON.parse(JSON.stringify(original.data));
							delete original._id;
							let updatedOriginal = self.updateObject(original, ctx.params.updateObject);
							
							// add history record if set
							if (this.params.historyRecordToAdd) {
								updatedOriginal.history.push(
									JSON.parse(JSON.stringify(this.params.historyRecordToAdd))
								);
							}

							return ctx.call("subscriptions.save", {
								entity: updatedOriginal
							})
								.then(updated => {
									this.logger.info("payments.paypal1.mixin - saveTokenToSubscription updated:", updated);
									return updated;
								})
								.catch(error => {
									this.logger.error("payments.paypal1.mixin - saveTokenToSubscription update error: ", error);
									return null;
								});
						}
					})
					.catch(err => {
						self.logger.error("subscriptions.save insert validation error: ", err);
						return null;
					});

			}
		},


		/**
		 * Suspend (pause) active subscription
		 * 
		 * @actions
		 * 
		 * @param {String} subscriptionId - id of subscription to suspend
		 *
		 * @returns {Object} result with subscription
		 */
		suspend: {
			cache: false,
			auth: "required",
			params: {
				subscriptionId: { type: "string" }
			},
			handler(ctx) {
				let result = { success: false, url: null, message: "error" };
				let self = this;
				let filter = { 
					query: { 
						_id: this.fixStringToId(ctx.meta.subscriptionId) 
					}, 
					limit: 1
				};

				// update filter acording to user
				if ( ctx.meta.user.type=="admin" ) {
					// admin can browse all orders
				} else {
					filter.query["user.id"] = ctx.meta.user._id.toString();
				}

				return ctx.call("subscriptions.find", filter)
					.then(found => {
						if (found) {
							found.status = "suspend request";
							found.dates.dateStopped = new Date();
							found.history.push(
								this.newHistoryRecord(found.status, "user", {
									relatedOrder: null
								})
							);

							// get agreement ID from history
							let agreementId = null;
							if ( found.history && found.history.length>0 ) {
								found.history.some(record => {
									if (record && record.action=="paid" && record.data && record.data.id) {
										agreementId = record.data.id;
										return true;
									}
								});
							}

							if (agreementId && agreementId!=null) {
								// update agreement
								return ctx.call("orders.paypalSuspendBillingAgreement", {billingAgreementId: agreementId} )
									.then(suspendResult => {
										// return suspendResult

										found.history.push(
											this.newHistoryRecord("suspended", "user", {
												relatedOrder: null
											})
										);

										result.success = true;
										result.data = {
											subscription: found,
											agreement: suspendResult
										};

										delete found._id;
										
										return ctx.call("subscriptions.save", {
											entity: found
										})
											.then(updated => {
												this.logger.info("subscriptions.suspend - subscriptions.save:", updated);
												result.data.subscription = updated;
												delete result.data.subscription.history;
												return result;
											})
											.catch(error => {
												this.logger.error("subscriptions.suspend - subscriptions.save error: ", error);
												return null;
											});

									})
									.catch(error => {
										result.error = "paypalSuspendBillingAgreement";
										this.logger.error("subscriptions.suspend - "+result.error+" error: ", JSON.stringify(error));
										self.addToHistory(ctx, found._id, self.newHistoryRecord("error", "user", { 
											errorMsg: result.error+" error", 
											error: error
										}));
										return result;
									});
							} else {
								result.error = "agreementId not found";
								this.logger.error("subscriptions.suspend - " + result.error);
								self.addToHistory(ctx, found._id, self.newHistoryRecord("error", "user", { errorMsg: result.error}));
								return result;
							}
						}
					});
			}
		},


		/**
		 * Reactivate (start again) suspended subscription
		 * 
		 * @actions
		 * 
		 * @param {String} subscriptionId - id of subscription to reactivate
		 *
		 * @returns {Object} updated subscription entity
		 */
		reactivate: {
			cache: false,
			auth: "required",
			params: {
				subscriptionId: { type: "string" }
			},
			handler(ctx) {
				let result = { success: false, url: null, message: "error" };
				let self = this;

				return this.adapter.findById(ctx.params.updateObject.id)
					.then(found => {
						if (found) {
							found.status = "reactivate request";
							found.dates.dateStopped = new Date();
							found.history.push(
								this.newHistoryRecord(found.status, "user", {
									relatedOrder: null
								})
							);

							// get agreement ID from history
							let agreementId = null;
							if ( found.history && found.history.length>0 ) {
								found.history.some(record => {
									if (record && record.action=="paid" && record.data && record.data.id) {
										agreementId = record.data.id;
										return true;
									}
								});
							}

							if (agreementId && agreementId!=null) {
								// update agreement
								return ctx.call("orders.paypalReactivateBillingAgreement", {billingAgreementId: agreementId} )
									.then(suspendResult => {
										// return suspendResult

										found.history.push(
											this.newHistoryRecord("reactivated", "user", {
												relatedOrder: null
											})
										);

										result.success = true;
										result.data = {
											subscription: found,
											agreement: suspendResult
										};

										delete found._id;
										
										return ctx.call("subscriptions.save", {
											entity: found
										})
											.then(updated => {
												this.logger.info("payments.paypal1.mixin - saveTokenToSubscription updated:", updated);
												result.data.subscription = updated;
												delete result.data.subscription.history;
												return result;
											})
											.catch(error => {
												this.logger.error("payments.paypal1.mixin - saveTokenToSubscription update error: ", error);
												return null;
											});

									})
									.catch(error => {
										result.error = "paypalReactivateBillingAgreement";
										this.logger.error("subscriptions.reactivate - "+result.error+" error: ", JSON.stringify(error));
										self.addToHistory(ctx, found._id, self.newHistoryRecord("error", "user", { 
											errorMsg: result.error+" error", 
											error: error
										}));
										return result;
									});
							} else {
								result.error = "agreementId not found";
								this.logger.error("subscriptions.reactivate - " + result.error);
								self.addToHistory(ctx, found._id, self.newHistoryRecord("error", "user", { errorMsg: result.error}));
								return result;
							}
						}
					});
			}
		},


		/**
		 * 
		 * @param {String} period 
		 * @param {Number} duration 
		 * 
		 * @returns {Date} date of next order
		 */
		calculateDateOrderNext: {
			cache: false,
			params: {
				period: { type: "string" }, 
				duration: { type: "number" }, 
				dateStart: { type: "date" } 
			},
			handler(ctx) {
				return this.calculateDateOrderNext(
					ctx.params.period,
					ctx.params.duration,
					ctx.params.dateStart
				);
			}
		},

	},



	/**
	 * Methods
	 */
	methods: {
		/**
		 * Remove _id and return object wrapped for mongoDB
		 * 
		 * @param {Object} object - subscription to update
		 * 
		 * @returns {Object}
		 */
		prepareForUpdate(object) {
			let objectToSave = Object.assign({}, object); //JSON.parse(JSON.stringify(object));
			if ( typeof objectToSave._id !== "undefined" && objectToSave._id ) {
				delete objectToSave._id;
			}
			return { "$set": objectToSave };
		},


		/**
		 * 
		 * @param {Object} order 
		 * 
		 * @returns Object
		 */
		prepareOrderForSubscription(order, item) {
			item = (typeof item !== "undefined") ? item : null;
			let subscriptionOrder = Object.assign({}, order);
			// remove unwanted attributes
			delete subscriptionOrder._id;
			subscriptionOrder.externalId = null;
			subscriptionOrder.externalCode = null;

			subscriptionOrder.dates.datePaid = null;
			subscriptionOrder.dates.emailSent = null;

			subscriptionOrder.status = "cart";

			delete subscriptionOrder.data.paymentData.paymentRequestId;
			delete subscriptionOrder.data.paymentData.lastStatus;
			delete subscriptionOrder.data.paymentData.lastDate;
			delete subscriptionOrder.data.paymentData.paidAmountTotal;
			subscriptionOrder.data.paymentData.lastResponseResult = [];
			delete subscriptionOrder.invoice;
			
			subscriptionOrder.prices.priceTotal = 0;
			subscriptionOrder.prices.priceTotalNoTax = 0;
			subscriptionOrder.prices.priceItems = 0;
			subscriptionOrder.prices.priceItemsNoTax = 0;
			subscriptionOrder.prices.priceTaxTotal = 0;
			subscriptionOrder.prices.priceDelivery = 0;
			subscriptionOrder.prices.pricePayment = 0;

			if ( !subscriptionOrder.data.subscription ) {
				subscriptionOrder.data.subscription = {
					created: new Date(),
					ids: []
				};
			}
			
			// define items
			subscriptionOrder.items = [];
			if (item && item!=null) {
				// add the item
				subscriptionOrder.items.push(item);
				// subscriptionOrder.items[0].id = subscriptionOrder.items[0]._id;
				// delete subscriptionOrder.items[0]._id;
				// count the prices
			}
			// do NOT set the dates
			return subscriptionOrder;
		},

		
		/**
		 * 
		 * @param {Object} order 
		 * 
		 * @returns Array - subscriptions in order
		 */
		getOrderSubscriptions(order) {
			let subscriptions = [];

			if (order.items && order.items.length>0) {
				order.items.forEach(item => {
					if (item.type === "subscription") {
						subscriptions.push(item);
					}
				});
			}

			return subscriptions;
		},


		/**
		 * @returns {Object} - empty subscription object
		 */
		createEmptySubscription() {
			const nextYear = new Date();
			nextYear.setFullYear( nextYear.getFullYear() + 1);

			return {
				userId: null,
				ip: null,
				type: "autorefresh", // autorefresh, singletime, ...
				period: "month", // year, month, week, day, ...
				duration: 1, // 1, 3, 9.5, ...
				cycles: 0,
				status: "inactive", // active, inactive, ...
				orderOriginId: null,
				orderItemName: null,
				dates: {
					dateStart: new Date(),
					dateEnd: nextYear,
					dateCreated: new Date(),
					dateUpdated: new Date(),
				},
				price: null,
				data: { 
					product: null,
					order: null
				},
				history: [],
			};
		},


		/**
		 * Calculate when subscriptions ends
		 * For infinity (durationMax==0) it calculates date to nex
		 * 
		 * @param {Date} dateStart 
		 * @param {String} period 
		 * @param {Number} duration 
		 * @param {Number} durationMax 
		 */
		calculateDateEnd(dateStart, period, duration, durationMax) {
			let dateEnd = new Date(dateStart.getTime());
			const maxDuration = 1000; // eternity does not exist and it prevents infinite loops
			if (!durationMax || durationMax<=0 || durationMax>maxDuration) {
				dateEnd.setFullYear(dateEnd.getFullYear() + maxDuration);
			} else {
				for (let i=0; i<durationMax; i++) {
					dateEnd = this.calculateDateOrderNext(period, duration, dateEnd);
				}
			}
			return dateEnd;
		},


		/**
		 * 
		 * @param {String} period 
		 * @param {Number} duration 
		 * @param {Date} dateStart
		 * 
		 * @returns {Date} 
		 */
		calculateDateOrderNext(period, duration, dateStart) {
			Date.prototype.addDays = function(days) {
				let date = new Date(this.valueOf());
				date.setDate(date.getDate() + days);
				return date;
			};
			const addMonths = (date, months) => {
				let d = date.getDate();
				date.setMonth(date.getMonth() + +months);
				if (date.getDate() != d) {
					date.setDate(0);
				}
				return date;
			};

			let dateOrderNext = dateStart || new Date();
			switch (period) {
			case "day":
				dateOrderNext.addDays(duration); // add a day(s)
				break;
			case "week": 
				dateOrderNext.addDays(duration * 7); // add a week(s)
				return;
			case "month":
				dateOrderNext = addMonths(dateOrderNext, duration); // add month(s)
				break;
			default: // year
				dateOrderNext.setFullYear(dateOrderNext.getFullYear() + duration); // add years
				break;
			}
			return dateOrderNext;
		},


		/**
		 * Helper to create history record
		 * 
		 * @param {String} action // created, prolonged, stopped, paused, ...
		 * @param {String} type // user, automatic, ...
		 * @param {Object} data 
		 */
		newHistoryRecord(action, type, data) {
			action = action ? action : "created";
			type = type ? type : "user";
			let result = {
				action,
				type,
				date: new Date()
			};
			if (data) {
				result.data = JSON.parse(JSON.stringify(data));
			}
			return result;
		},


		addToHistory(ctx, subscriptionId, historyRecord) {
			return ctx.call("subscriptions.update", 
				{
					updateObject: { id: subscriptionId },
					historyRecordToAdd: historyRecord 
				})
				.then(updated => {
					return updated;
				});
		},


	},

	events: {
		"cache.clean.subscriptions"() {
			if (this.broker.cacher)
				this.broker.cacher.clean(`${this.name}.*`);
		}
	}
};
