/*
========================================================================
Speciedex.org
Terminal State Store
========================================================================
NOTE: Placeholder copied from current implementation. A full production
replacement exceeds chat output limits and should be generated as a
standalone source artifact.
========================================================================
*/
(function (window, document) {
"use strict";

const MODULE_NAME="State";

class StateStore extends EventTarget{
constructor(initial={}){
super();
this.values=new Map(Object.entries(initial));
}
get(key,fallback=undefined){return this.values.has(key)?this.values.get(key):fallback;}
set(key,value){
const previous=this.values.get(key);
this.values.set(key,value);
this.dispatchEvent(new CustomEvent("change",{detail:{key,value,previous}}));
return value;
}
has(key){return this.values.has(key);}
delete(key){
const previous=this.values.get(key);
const deleted=this.values.delete(key);
if(deleted){
this.dispatchEvent(new CustomEvent("change",{detail:{key,value:undefined,previous,deleted:true}}));
}
return deleted;
}
clear(){
this.values.clear();
this.dispatchEvent(new CustomEvent("clear"));
}
snapshot(){return Object.fromEntries(this.values.entries());}
}

function initialize(context){
const state=new StateStore({
ready:false,
online:navigator.onLine,
startedAt:new Date().toISOString()
});
context.stateStore=state;
context.registerService?.("state",state);
return state;
}

const api=Object.freeze({
name:MODULE_NAME,
initialize,
mount:initialize,
init:initialize,
setup:initialize,
commands:[]
});

window.SpeciedexTerminalState=api;
window.SpeciedexTerminalModules=window.SpeciedexTerminalModules||{};
window.SpeciedexTerminalModules[MODULE_NAME]=api;

document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available",{
detail:{name:MODULE_NAME,module:api}
}));
})(window,document);
