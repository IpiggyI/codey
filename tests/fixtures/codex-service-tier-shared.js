var $at=`ultrafast`,eot=`default`;
function Xat(e,t,n={fast:!0,ultrafast:!0}){let r=t??Yat(e,e?.defaultServiceTier??null);return r===eot||!Wat(r,n)?null:r}
function Uat(e){let t=e.requirements?.featureRequirements,n=t?.fast_mode!==!1;return{fast:n,ultrafast:(`supportsIndependentSpeedModes`in e&&e.supportsIndependentSpeedModes===!0||n)&&t?.ultrafast_mode!==!1}}
function Wat(e,t){if(e==null||e===eot)return!0;if(t==null)return!1;let n=Gat(e);return e===`flex`||t[n??`fast`]}
function Yat(e,t){return Kat(e,t)?.id??null}
function Kat(e,t){return t==null?null:t===`fast`?qat(e):e?.serviceTiers?.find(e=>e.id===t)??null}
function Gat(e,t){let n=t?.trim().toLowerCase();return e===`priority`||e===`fast`||n===`fast`?`fast`:e===$at||n===`ultrafast`?`ultrafast`:null}
function qat(e){return e?.serviceTiers?.find(e=>Gat(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null}
