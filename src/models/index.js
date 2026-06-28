const mongoose = require('mongoose');
const { Schema, model, models } = mongoose;

// Compatibility IDs keep the existing Flutter/Admin clients working while MongoDB
// remains the source of truth. New top-level documents receive a numeric legacyId.
mongoose.plugin((schema) => {
  if (schema.options.timestamps !== true) return;
  schema.add({ legacyId: { type: Number, index: true, sparse: true } });
  schema.pre('save', async function assignLegacyId(next) {
    try {
      if (!this.constructor?.modelName || this.legacyId != null) return next();
      const key = `legacy:${this.constructor.collection.collectionName}`;
      const result = await mongoose.connection.collection('_counters').findOneAndUpdate(
        { _id: key },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
      );
      this.legacyId = result.value?.seq ?? result.seq;
      next();
    } catch (error) { next(error); }
  });
});
const objectId = (ref, required=false) => ({ type: Schema.Types.ObjectId, ref, required, index: true });
const money = { type: Number, min: 0, default: 0 };
const imageSchema = new Schema({ url:String, publicId:String, alt:String }, { _id:false });
const addressSchema = new Schema({ label:String, line1:String, line2:String, area:String, city:String, state:String, pincode:String, landmark:String, latitude:Number, longitude:Number, isDefault:{type:Boolean,default:false}, serviceable:{type:Boolean,default:false}, serviceabilityCheckedAt:Date, nearestOutletId:objectId('Outlet'), distanceKm:Number, allowedRadiusKm:Number, validationMessage:String }, { timestamps:true });

const User = models.User || model('User', new Schema({
  name:{type:String,required:true,trim:true}, username:{type:String,trim:true,lowercase:true,sparse:true,unique:true,index:true}, email:{type:String,trim:true,lowercase:true,sparse:true,unique:true}, phone:{type:String,trim:true,sparse:true,unique:true}, passwordHash:{type:String,required:true,select:false}, passwordResetCodeHash:{type:String,select:false}, passwordResetExpiresAt:Date, passwordChangedAt:Date, role:{type:String,enum:['ADMIN','SELLER','RIDER','CUSTOMER'],default:'CUSTOMER',index:true}, active:{type:Boolean,default:true}, deleted:{type:Boolean,default:false,index:true}, deletedAt:Date, deletedBy:objectId('User'), deleteReason:String, avatar:imageSchema, assignedOutletIds:[objectId('Outlet')], addresses:[addressSchema], favoriteProductIds:[objectId('Product')], walletBalance:{type:Number,default:0,min:0}, rewardPoints:{type:Number,default:0,min:0}, fcmTokens:[String], lastLoginAt:Date, riderProfile:{online:{type:Boolean,default:false},available:{type:Boolean,default:false},verificationStatus:{type:String,default:'UNVERIFIED',index:true},rating:{type:Number,default:0},cashLimit:{type:Number,default:2000,min:0},payoutAccount:{accountHolderName:String,accountNumber:String,ifsc:String,bankName:String,upiId:String,verified:{type:Boolean,default:false}},passportPhoto:imageSchema,vehicle:{type:String,vehicleNumber:String,licenseNumber:String}, currentLatitude:Number,currentLongitude:Number,lastLocationAt:Date, upiReminderSentAt:Date},
  sellerProfile:{payoutAccount:{accountHolderName:String,bankName:String,accountNumber:String,ifscCode:String,upiId:String,verified:{type:Boolean,default:false},status:{type:String,enum:['PENDING','VERIFIED','REJECTED'],default:'PENDING'},reviewedAt:Date,reviewedBy:objectId('User'),adminNote:String}}
},{timestamps:true}));

const Outlet = models.Outlet || model('Outlet', new Schema({
  name:{type:String,required:true,trim:true}, slug:{type:String,required:true,unique:true,index:true}, code:{type:String,unique:true,sparse:true}, logo:imageSchema, coverImage:imageSchema, gstin:String, businessRegistration:String, managerName:String, managerPhone:String, email:String, managerUserId:objectId('User'), address:{line1:String,line2:String,area:String,city:String,state:String,pincode:String,landmark:String}, location:{type:{type:String,enum:['Point'],default:'Point'},coordinates:{type:[Number],default:[0,0]}}, deliveryRadiusKm:{type:Number,default:10,min:0}, operatingHours:{type:Schema.Types.Mixed,default:{}}, active:{type:Boolean,default:true,index:true}, open:{type:Boolean,default:false,index:true}, primary:{type:Boolean,default:false,index:true}, rating:{type:Number,default:0}, ratingCount:{type:Number,default:0}, featureToggles:{delivery:{type:Boolean,default:true},takeaway:{type:Boolean,default:true},cod:{type:Boolean,default:true},onlinePayment:{type:Boolean,default:true},riderAssignment:{type:Boolean,default:true},offers:{type:Boolean,default:true}}, deliverySettings:{baseCharge:{type:Number,default:0},perKmCharge:{type:Number,default:0},minimumCharge:{type:Number,default:0},maximumCharge:{type:Number,default:9999}}, createdBy:objectId('User')
},{timestamps:true}));
Outlet.schema.index({location:'2dsphere'});

const Category = models.Category || model('Category', new Schema({ name:{type:String,required:true,trim:true}, slug:{type:String,required:true,unique:true,index:true}, image:imageSchema, description:String, active:{type:Boolean,default:true,index:true}, parentId:objectId('Category'), sortOrder:{type:Number,default:0} },{timestamps:true}));
const Brand = models.Brand || model('Brand', new Schema({name:{type:String,required:true},slug:{type:String,required:true,unique:true},image:imageSchema,active:{type:Boolean,default:true}}, {timestamps:true}));
const Cuisine = models.Cuisine || model('Cuisine', new Schema({name:{type:String,required:true,trim:true},slug:{type:String,required:true,unique:true,index:true},image:imageSchema,description:String,active:{type:Boolean,default:true,index:true},sortOrder:{type:Number,default:0}}, {timestamps:true}));
const Product = models.Product || model('Product', new Schema({
  name:{type:String,required:true,trim:true}, slug:{type:String,required:true,unique:true,index:true}, sku:{type:String,unique:true,sparse:true,index:true}, description:String, images:[imageSchema], categoryId:objectId('Category'), subcategoryId:objectId('Category'), brandId:objectId('Brand'), cuisineId:objectId('Cuisine'), basePrice:money, offerPrice:money, ingredients:[String], nutritionalInfo:Schema.Types.Mixed, active:{type:Boolean,default:true,index:true}, featured:{type:Boolean,default:false}, foodType:{type:String,enum:['VEG','NON_VEG','EGG','VEGAN','OTHER'],default:'OTHER'},
  variantType:{type:String,enum:['STANDARD','PIZZA','CAKE'],default:'STANDARD',index:true},
  defaultVariant:{type:String,default:''},
  sizePrices:{small:{type:Number,min:0},medium:{type:Number,min:0},large:{type:Number,min:0}},
  weightPrices:{gm500:{type:Number,min:0},kg1:{type:Number,min:0},kg15:{type:Number,min:0},kg2:{type:Number,min:0}},
  cakeMessageEnabled:{type:Boolean,default:false},cakeMessageCharge:{type:Number,min:0,default:0},customWeightEnabled:{type:Boolean,default:false},
  customWeightOptions:[{label:{type:String,trim:true},grams:{type:Number,min:1},price:{type:Number,min:0},active:{type:Boolean,default:true}}],
  customizationGroups:[{name:String,type:{type:String,enum:['SINGLE','MULTIPLE']},required:Boolean,minSelect:Number,maxSelect:Number,options:[{name:String,price:Number,active:{type:Boolean,default:true},default:{type:Boolean,default:false}}]}], createdBy:objectId('User')
},{timestamps:true}));

const OutletProduct = models.OutletProduct || model('OutletProduct', new Schema({
  outletId:objectId('Outlet',true), productId:objectId('Product',true), enabled:{type:Boolean,default:true,index:true}, available:{type:Boolean,default:true,index:true}, stockQuantity:{type:Number,default:0,min:0}, reservedQuantity:{type:Number,default:0,min:0}, lowStockThreshold:{type:Number,default:5,min:0}, priceOverride:{type:Number,min:0}, offerPriceOverride:{type:Number,min:0}, costPrice:{type:Number,min:0}, preparationMinutes:{type:Number,default:20,min:0}, version:{type:Number,default:0}, stockInitialized:{type:Boolean,default:false,index:true}, lastStockUpdatedAt:Date, lastStockUpdatedBy:objectId('User')
},{timestamps:true}));
OutletProduct.schema.index({outletId:1,productId:1},{unique:true});

const Cart = models.Cart || model('Cart', new Schema({ customerId:objectId('User',true), outletId:objectId('Outlet',true), items:[{productId:objectId('Product',true),quantity:{type:Number,min:1,required:true},customizations:[{groupName:String,optionName:String,price:Number}],selectedSize:String,selectedWeight:String,cakeMessage:String}], couponCode:String },{timestamps:true}));
Cart.schema.index({customerId:1,outletId:1},{unique:true});

const orderItemSchema = new Schema({ productId:objectId('Product'), name:String, slug:String, sku:String, image:String, quantity:Number, unitPrice:Number, offerPrice:Number, tax:Number, customizations:[Schema.Types.Mixed], selectedSize:String, selectedWeight:String, cakeMessage:String, addOnTotal:{type:Number,default:0}, finalTotal:Number },{_id:true});
const Order = models.Order || model('Order', new Schema({
  slug:{type:String,required:true,unique:true,index:true}, clientRequestId:{type:String,sparse:true,unique:true}, customerId:objectId('User',true), outletId:objectId('Outlet',true), sellerId:objectId('User'), riderId:objectId('User'), items:[orderItemSchema], address:addressSchema, fulfilmentType:{type:String,enum:['DELIVERY','TAKEAWAY'],default:'DELIVERY',index:true}, status:{type:String,default:'RECEIVED',index:true}, paymentMethod:{type:String,enum:['COD','ONLINE','WALLET','TAKEAWAY_ADVANCE'],default:'COD'}, paymentStatus:{type:String,default:'PENDING',index:true}, subtotal:Number,discount:Number,tax:Number,deliveryCharge:Number,total:Number,payableOnlineAmount:Number,paidAmount:{type:Number,default:0},balanceDue:{type:Number,default:0},takeawayAdvancePercentage:Number,couponCode:String,distanceKm:Number,cancellationReason:String,refundStatus:String,invoiceStatus:String, acceptedAt:Date,readyAt:Date,pickedUpAt:Date,deliveredAt:Date,cancelledAt:Date,sellerAcceptanceDeadline:Date,riderAcceptanceDeadline:Date, outForDeliveryAt:Date,reachedDropAt:Date,cashCollected:{type:Boolean,default:false},cashCollectedAmount:{type:Number,default:0,min:0},cashCollectedAt:Date
},{timestamps:true}));
Order.schema.index({outletId:1,status:1,createdAt:-1}); Order.schema.index({customerId:1,createdAt:-1}); Order.schema.index({riderId:1,status:1});

const OrderEvent = models.OrderEvent || model('OrderEvent', new Schema({ orderId:objectId('Order',true), previousStatus:String,newStatus:String,actorType:String,actorId:objectId('User'),reason:String,metadata:Schema.Types.Mixed,idempotencyKey:{type:String,unique:true,sparse:true} },{timestamps:true}));
const InventoryMovement = models.InventoryMovement || model('InventoryMovement', new Schema({ outletId:objectId('Outlet',true),productId:objectId('Product',true),type:String,quantityBefore:Number,quantityChanged:Number,quantityAfter:Number,reservedBefore:Number,reservedAfter:Number,referenceType:String,referenceId:Schema.Types.ObjectId,reason:String,performedBy:objectId('User'),idempotencyKey:{type:String,unique:true} },{timestamps:true}));
const Payment = models.Payment || model('Payment', new Schema({ orderId:objectId('Order'),customerId:objectId('User',true),outletId:objectId('Outlet'),gateway:{type:String,default:'RAZORPAY'},gatewayOrderId:{type:String,sparse:true},gatewayPaymentId:{type:String,sparse:true},signature:String,amount:Number,currency:{type:String,default:'INR'},tax:Number,status:{type:String,default:'PENDING',index:true},failureReason:String,idempotencyKey:{type:String,unique:true,sparse:true},rawMetadata:Schema.Types.Mixed },{timestamps:true}));
Payment.schema.index({gateway:1,gatewayOrderId:1},{unique:true,sparse:true}); Payment.schema.index({gateway:1,gatewayPaymentId:1},{unique:true,sparse:true});

const PaymentWebhookEvent = models.PaymentWebhookEvent || model('PaymentWebhookEvent', new Schema({
  eventId:{type:String,required:true,unique:true,index:true},
  eventType:{type:String,required:true,index:true},
  gateway:{type:String,default:'RAZORPAY',index:true},
  signature:String,
  payloadHash:{type:String,required:true},
  processed:{type:Boolean,default:false,index:true},
  processedAt:Date,
  processingError:String,
  paymentId:objectId('Payment'),
  orderId:objectId('Order'),
  rawMetadata:Schema.Types.Mixed
},{timestamps:true}));

const Refund = models.Refund || model('Refund', new Schema({orderId:objectId('Order',true),paymentId:objectId('Payment',true),customerId:objectId('User',true),outletId:objectId('Outlet',true),amount:Number,cancellationReason:String,gatewayRefundId:String,status:{type:String,default:'PENDING',index:true},adminAcknowledgement:{type:Boolean,default:false},adminNote:String,processedBy:objectId('User'),processedAt:Date},{timestamps:true}));
Refund.schema.index({orderId:1,paymentId:1},{unique:true});
const RiderLocation = models.RiderLocation || model('RiderLocation', new Schema({riderId:objectId('User',true),orderId:objectId('Order'),location:{type:{type:String,default:'Point'},coordinates:[Number]},heading:Number,speed:Number,accuracy:Number,recordedAt:{type:Date,default:Date.now}}, {timestamps:true})); RiderLocation.schema.index({location:'2dsphere'}); RiderLocation.schema.index({riderId:1,recordedAt:-1});

const RiderCashTransaction = models.RiderCashTransaction || model('RiderCashTransaction', new Schema({riderId:objectId('User',true),orderId:objectId('Order'),type:{type:String,enum:['COLLECTED','DEPOSIT','ADMIN_CASH_CONFIRMED'],required:true,index:true},amount:{type:Number,required:true,min:0},paymentMethod:String,paymentReference:String,status:{type:String,default:'CONFIRMED'},note:String},{timestamps:true}));
RiderCashTransaction.schema.index({riderId:1,createdAt:-1});
RiderCashTransaction.schema.index({riderId:1,paymentReference:1},{unique:true,partialFilterExpression:{paymentReference:{$type:'string'}}});
const RiderEarning = models.RiderEarning || model('RiderEarning', new Schema({riderId:objectId('User',true),orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,unique:true},outletId:objectId('Outlet',true),distanceKm:Number,ratePerKm:Number,amount:Number,status:{type:String,enum:['PENDING','PAID'],default:'PENDING',index:true},settledAt:Date,payoutId:objectId('RiderPayout')},{timestamps:true}));

const RiderPayout = models.RiderPayout || model('RiderPayout', new Schema({
  riderId:objectId('User',true),
  periodStart:{type:Date,required:true,index:true},
  periodEnd:{type:Date,required:true,index:true},
  amount:{type:Number,required:true,min:0},
  upiId:String,
  paymentMethod:{type:String,default:'UPI'},
  paymentReference:String,
  status:{type:String,enum:['PENDING','PAID','FAILED','CANCELLED'],default:'PENDING',index:true},
  earningIds:[objectId('RiderEarning')],
  paidBy:objectId('User'),
  paidAt:Date,
  note:String
},{timestamps:true}));
RiderPayout.schema.index({riderId:1,periodStart:1,periodEnd:1},{unique:true});

const RiderSettlement = models.RiderSettlement || model('RiderSettlement', new Schema({
  riderId:objectId('User',true),amount:{type:Number,required:true,min:0},currency:{type:String,default:'INR'},
  method:{type:String,enum:['CASH','RAZORPAY'],required:true,index:true},
  status:{type:String,enum:['PENDING','APPROVED','PAID','REJECTED','FAILED','CANCELLED'],default:'PENDING',index:true},
  gatewayOrderId:{type:String,sparse:true,unique:true},gatewayPaymentId:{type:String,sparse:true,unique:true},signature:String,
  paymentReference:String,idempotencyKey:{type:String,sparse:true,unique:true},requestedAt:{type:Date,default:Date.now},
  reviewedBy:objectId('User'),reviewedAt:Date,paidAt:Date,note:String,adminNote:String,failureReason:String,rawMetadata:Schema.Types.Mixed
},{timestamps:true}));
RiderSettlement.schema.index({riderId:1,status:1,createdAt:-1});

const OfflineSale = models.OfflineSale || model('OfflineSale', new Schema({outletId:objectId('Outlet',true),sellerId:objectId('User',true),items:[{productId:objectId('Product',true),name:String,quantity:Number,unitPrice:Number,total:Number}],subtotal:Number,tax:Number,total:Number,paymentMode:String,notes:String,customerReference:String,idempotencyKey:{type:String,unique:true}},{timestamps:true}));
const Invoice = models.Invoice || model('Invoice', new Schema({orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,unique:true},invoiceNumber:{type:String,required:true,unique:true},invoiceDate:{type:Date,default:Date.now},pdfUrl:String,generatedAt:{type:Date,default:Date.now}},{timestamps:true}));
const Setting = models.Setting || model('Setting', new Schema({key:{type:String,required:true,unique:true,index:true},value:Schema.Types.Mixed,encryptedValue:String,encryptionIv:String,encryptionTag:String,isSecret:{type:Boolean,default:false,index:true},public:{type:Boolean,default:false},active:{type:Boolean,default:true,index:true},version:{type:Number,default:1},lastValidatedAt:Date,updatedBy:objectId('User')},{timestamps:true}));
const SettingAudit = models.SettingAudit || model('SettingAudit', new Schema({settingKey:{type:String,required:true,index:true},action:{type:String,required:true},changedBy:objectId('User'),previousMasked:Schema.Types.Mixed,nextMasked:Schema.Types.Mixed,requestId:String},{timestamps:true}));
const Notification = models.Notification || model('Notification', new Schema({userId:objectId('User'),outletId:objectId('Outlet'),role:String,title:String,message:String,type:String,data:Schema.Types.Mixed,read:{type:Boolean,default:false,index:true}},{timestamps:true}));

const AdminEmailLog = models.AdminEmailLog || model('AdminEmailLog', new Schema({
  recipientUserId:objectId('User',true), recipientRole:{type:String,index:true}, recipientEmail:{type:String,required:true,index:true},
  category:{type:String,enum:['PROMOTIONAL','ALERT','PAYMENT_REQUEST','DOCUMENT','GENERAL'],default:'GENERAL',index:true},
  subject:{type:String,required:true}, bodyText:String, bodyHtml:String,
  attachments:[{filename:String,contentType:String,size:Number}],
  provider:{type:String,default:'SMTP'}, providerMessageId:String,
  status:{type:String,enum:['PENDING','SENT','FAILED'],default:'PENDING',index:true}, errorCode:String,
  sentBy:objectId('User'), sentAt:Date
},{timestamps:true}));
AdminEmailLog.schema.index({recipientUserId:1,createdAt:-1});

const ClientErrorReport = models.ClientErrorReport || model('ClientErrorReport', new Schema({
  userId:objectId('User'), app:{type:String,default:'CUSTOMER',index:true}, screen:String, action:String,
  errorCode:String, safeMessage:String, endpoint:String, method:String, statusCode:Number,
  appVersion:String, platform:String, device:String, metadata:Schema.Types.Mixed,
  resolved:{type:Boolean,default:false,index:true}, resolvedBy:objectId('User'), resolvedAt:Date, adminNote:String
},{timestamps:true}));
ClientErrorReport.schema.index({createdAt:-1,resolved:1});

const BiteStory = models.BiteStory || model('BiteStory', new Schema({
  title:{type:String,required:true,trim:true},
  subtitle:{type:String,default:''},
  description:{type:String,default:''},
  media:imageSchema,
  mediaType:{type:String,enum:['IMAGE','VIDEO'],default:'IMAGE'},
  actionType:{type:String,default:''},
  actionValue:{type:String,default:''},
  sortOrder:{type:Number,default:0,index:true},
  active:{type:Boolean,default:true,index:true},
  startsAt:Date,
  endsAt:Date,
  createdBy:objectId('User')
},{timestamps:true}));

const Banner = models.Banner || model('Banner', new Schema({title:String,subtitle:String,description:String,image:imageSchema,actionType:String,actionValue:String,couponId:objectId('Coupon'),couponCode:{type:String,uppercase:true,trim:true,index:true},appliesToAllOutlets:{type:Boolean,default:true,index:true},outletIds:[objectId('Outlet')],startAt:Date,endAt:Date,active:{type:Boolean,default:true,index:true},sortOrder:{type:Number,default:0}},{timestamps:true}));
const Offer = models.Offer || model('Offer', new Schema({title:String,code:{type:String,unique:true,sparse:true},description:String,image:imageSchema,campaignType:{type:String,enum:['BANNER','COUPON_OFFER','GENERAL'],default:'GENERAL'},type:String,value:Number,minOrder:Number,maxDiscount:Number,startAt:Date,endAt:Date,active:{type:Boolean,default:true},appliesToAllOutlets:{type:Boolean,default:true,index:true},outletIds:[objectId('Outlet')],productIds:[objectId('Product')]},{timestamps:true}));
const Coupon = models.Coupon || model('Coupon', new Schema({code:{type:String,required:true,unique:true,uppercase:true},title:String,description:String,type:String,value:Number,minOrder:Number,maxDiscount:Number,usageLimit:Number,perUserLimit:Number,usedCount:{type:Number,default:0},startAt:Date,endAt:Date,active:{type:Boolean,default:true},appliesToAllOutlets:{type:Boolean,default:true,index:true},outletIds:[objectId('Outlet')],productIds:[objectId('Product')],paymentMethods:[{type:String,enum:['COD','ONLINE','WALLET','TAKEAWAY_ADVANCE']}],fulfilmentTypes:[{type:String,enum:['DELIVERY','TAKEAWAY']}],eligibleCustomerIds:[objectId('User')]},{timestamps:true}));
const CouponUsage = models.CouponUsage || model('CouponUsage', new Schema({couponId:objectId('Coupon',true),code:{type:String,required:true,index:true},customerId:objectId('User',true),orderId:{type:Schema.Types.ObjectId,ref:'Order',required:true,unique:true},outletId:objectId('Outlet',true),discountAmount:{type:Number,default:0,min:0},status:{type:String,enum:['RESERVED','CONSUMED','RELEASED'],default:'RESERVED',index:true}},{timestamps:true}));
CouponUsage.schema.index({couponId:1,customerId:1,status:1});
const Review = models.Review || model('Review', new Schema({customerId:objectId('User',true),orderId:objectId('Order',true),outletId:objectId('Outlet',true),productId:objectId('Product'),rating:{type:Number,min:1,max:5},comment:String},{timestamps:true})); Review.schema.index({customerId:1,orderId:1},{unique:true});
const WalletTransaction = models.WalletTransaction || model('WalletTransaction', new Schema({userId:objectId('User',true),type:{type:String,enum:['CREDIT','DEBIT']},amount:Number,referenceType:String,referenceId:Schema.Types.ObjectId,description:String,balanceAfter:Number},{timestamps:true}));
const SupportTicket = models.SupportTicket || model('SupportTicket', new Schema({userId:objectId('User',true),subject:String,message:String,status:{type:String,default:'OPEN',index:true},priority:{type:String,default:'NORMAL'},assignedTo:objectId('User'),responses:[{senderId:objectId('User'),message:String,createdAt:{type:Date,default:Date.now}}]},{timestamps:true}));
const VerificationRequest = models.VerificationRequest || model('VerificationRequest', new Schema({userId:objectId('User',true),outletId:objectId('Outlet'),type:String,status:{type:String,default:'PENDING',index:true},documents:[imageSchema],note:String,reviewedBy:objectId('User'),reviewedAt:Date},{timestamps:true}));
const DailyClosing = models.DailyClosing || model('DailyClosing', new Schema({outletId:objectId('Outlet',true),sellerId:objectId('User',true),businessDate:{type:String,required:true},stockSnapshot:[{productId:objectId('Product'),openingStock:Number,stockQuantity:Number,reservedQuantity:Number,availableStock:Number,lowStockThreshold:Number}],onlineSales:Number,offlineSales:Number,offlineCashSales:Number,offlineUpiSales:Number,offlineCardSales:Number,offlineOtherSales:Number,offlineOrderCount:Number,refunds:Number,expenses:Number,totalSales:Number,status:{type:String,enum:['DRAFT','SUBMITTED','APPROVED','REJECTED','CORRECTION_REQUIRED'],default:'SUBMITTED',index:true},reviewNote:String,reviewedBy:objectId('User'),reviewedAt:Date,notes:String,submittedAt:{type:Date,default:Date.now}},{timestamps:true})); DailyClosing.schema.index({outletId:1,businessDate:1},{unique:true});

module.exports={User,Outlet,Category,Brand,Cuisine,Product,OutletProduct,Cart,Order,OrderEvent,InventoryMovement,Payment,PaymentWebhookEvent,Refund,RiderLocation,RiderCashTransaction,RiderEarning,RiderPayout,RiderSettlement,OfflineSale,Invoice,Setting,SettingAudit,Notification,AdminEmailLog,ClientErrorReport,BiteStory,Banner,Offer,Coupon,CouponUsage,Review,WalletTransaction,SupportTicket,VerificationRequest,DailyClosing};
