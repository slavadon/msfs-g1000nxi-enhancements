/**
 * Garmin G1000 NXi Real-World Avionics Enhancements for MSFS 2020 (WTG1000)
 * Version: 2.0.0 (Build 800)
 *
 * Standalone global WTG1000 AvionicsPlugin supporting all G1000 NXi aircraft
 * (Asobo Cessna 172 Skyhawk G1000, Carenado CT182T, C208B, G36, G58, DA40NG, DA62, SR22, etc.)
 * without modifying any Official MSFS package files.
 */
(function () {
    const sdk = window.msfssdk;
    if (!sdk || typeof sdk.registerPlugin !== 'function') {
        return;
    }

    const g1000Mod = window.g1000nxipfd || window.g1000nximfd || {};
    const BasePlugin = g1000Mod.G1000AvionicsPlugin || sdk.AvionicsPlugin;
    if (!BasePlugin) {
        return;
    }

    const shouldInstallG1000Enhancements = !window.__WTG1000_NXI_ENHANCEMENTS_VER__;
    if (shouldInstallG1000Enhancements) {
        window.__WTG1000_NXI_ENHANCEMENTS_VER__ = 800;
    }

    // =========================================================================
    // 1. WTG1000 NXi Missed-Approach Procedure Load Fix (PFD & MFD)
    // =========================================================================

    function isHoldLegType(legType) {
        if (!sdk) {
            return false;
        }
        if (sdk.FlightPlanUtils && typeof sdk.FlightPlanUtils.isHoldLeg === 'function') {
            return sdk.FlightPlanUtils.isHoldLeg(legType);
        }
        const Lt = sdk.LegType || {};
        return legType === Lt.HM || legType === Lt.HF || legType === Lt.HA;
    }

    function isFixTerminatingLegType(legType) {
        if (!sdk) {
            return false;
        }
        if (isHoldLegType(legType)) {
            return true;
        }
        if (sdk.FlightPlanUtils && typeof sdk.FlightPlanUtils.isToFixLeg === 'function') {
            return sdk.FlightPlanUtils.isToFixLeg(legType);
        }
        const Lt = sdk.LegType || {};
        return legType === Lt.AF || legType === Lt.CF || legType === Lt.DF
            || legType === Lt.IF || legType === Lt.RF || legType === Lt.TF;
    }

    function isFacilityIcao(icao) {
        if (!icao || typeof icao !== 'string') {
            return false;
        }
        if (sdk && sdk.ICAO && typeof sdk.ICAO.isFacility === 'function') {
            return sdk.ICAO.isFacility(icao);
        }
        return icao.trim().length > 0;
    }

    function cloneVectorArray(arr) {
        if (!Array.isArray(arr)) {
            return [];
        }
        const out = [];
        for (let i = 0; i < arr.length; i++) {
            out.push(Object.assign({}, arr[i]));
        }
        return out;
    }

    function cloneLegCalculations(calc) {
        if (!calc) {
            return undefined;
        }
        return {
            courseMagVar: calc.courseMagVar || 0,
            startLat: calc.startLat,
            startLon: calc.startLon,
            endLat: calc.endLat,
            endLon: calc.endLon,
            distance: calc.distance || 0,
            distanceWithTransitions: calc.distanceWithTransitions || 0,
            initialDtk: calc.initialDtk,
            cumulativeDistance: calc.cumulativeDistance || 0,
            cumulativeDistanceWithTransitions: calc.cumulativeDistanceWithTransitions || 0,
            flightPath: cloneVectorArray(calc.flightPath),
            ingress: cloneVectorArray(calc.ingress),
            ingressJoinIndex: calc.ingressJoinIndex !== undefined ? calc.ingressJoinIndex : -1,
            ingressToEgress: cloneVectorArray(calc.ingressToEgress),
            egressJoinIndex: calc.egressJoinIndex !== undefined ? calc.egressJoinIndex : -1,
            egress: cloneVectorArray(calc.egress),
            endsInFallback: !!calc.endsInFallback
        };
    }

    /**
     * Checks whether the active flight plan is currently in the missed approach
     * with at most one distinct fix remaining (e.g., inbound to the final holding
     * fix / MAHP, established in the missed-approach hold at the MAHP, or on a
     * terminal VM/FM missed-approach leg).
     */
    function isPastLastFixInMissedApproach(fms) {
        try {
            if (!fms || typeof fms.hasPrimaryFlightPlan !== 'function' || !fms.hasPrimaryFlightPlan()) {
                return false;
            }
            const garmin = window.garminsdk;
            if (garmin && garmin.DirectToState && typeof fms.getDirectToState === 'function') {
                if (fms.getDirectToState() === garmin.DirectToState.TORANDOM) {
                    return false;
                }
            }

            const plan = fms.getPrimaryFlightPlan();
            if (!plan || plan.length < 2 || plan.segmentCount < 1) {
                return false;
            }

            const activeGlobalIndex = plan.activeLateralLeg;
            if (activeGlobalIndex < 0 || activeGlobalIndex >= plan.length) {
                return false;
            }

            const activeSegIndex = plan.getSegmentIndex(activeGlobalIndex);
            if (activeSegIndex < 0) {
                return false;
            }

            const activeSegment = plan.getSegment(activeSegIndex);
            if (!activeSegment || activeSegment.segmentType !== sdk.FlightPlanSegmentType.Approach) {
                return false;
            }

            const activeSegLegIndex = activeGlobalIndex - activeSegment.offset;
            const activeLeg = activeSegment.legs[activeSegLegIndex];
            if (!activeLeg || !activeLeg.leg) {
                return false;
            }

            // Must be on a missed-approach leg
            const missedFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.MissedApproach) ? sdk.LegDefinitionFlags.MissedApproach : 2;
            if ((activeLeg.flags & missedFlag) !== missedFlag) {
                return false;
            }

            // Count distinct facility fixes remaining from the active missed-approach leg to the end of the procedure.
            // True once only the final missed-approach fix (+ its hold) or fewer remains.
            const distinctFixes = new Set();
            for (let i = activeSegLegIndex; i < activeSegment.legs.length; i++) {
                const lDef = activeSegment.legs[i];
                if (!lDef || !lDef.leg) {
                    continue;
                }
                if (isFixTerminatingLegType(lDef.leg.type) && isFacilityIcao(lDef.leg.fixIcao)) {
                    distinctFixes.add(lDef.leg.fixIcao.trim());
                }
            }

            return distinctFixes.size <= 1;
        } catch (e) {
            return false;
        }
    }

    function isDirectToRandomWithLoadablePrimary(fms) {
        try {
            const garmin = window.garminsdk;
            if (!fms || !garmin || !garmin.DirectToState || typeof fms.getDirectToState !== 'function') {
                return false;
            }
            if (fms.getDirectToState() !== garmin.DirectToState.TORANDOM) {
                return false;
            }
            if (typeof fms.hasPrimaryFlightPlan !== 'function' || !fms.hasPrimaryFlightPlan()) {
                return false;
            }
            const plan = fms.getPrimaryFlightPlan();
            if (!plan || plan.length < 2) {
                return false;
            }
            let nonApprLegCount = 0;
            for (const seg of plan.segments()) {
                if (seg.segmentType !== sdk.FlightPlanSegmentType.Approach) {
                    nonApprLegCount += seg.legs.length;
                }
            }
            return nonApprLegCount >= 1;
        } catch (e) {
            return false;
        }
    }

    /**
     * Relocates the remaining active missed-approach tail (e.g., inbound-to-MAHP leg + hold,
     * or active hold leg at MAHP) into the last non-airway Enroute segment and updates
     * activeLateralLeg to the relocated active leg, preserving continuous LNav guidance while
     * a new procedure is loaded below Enroute.
     */
    function relocateActiveMissedLegToEnroute(fms, clearStaleArrival) {
        const plan = fms.getPrimaryFlightPlan();
        const activeGlobalIndex = plan.activeLateralLeg;
        const activeSegIndex = plan.getSegmentIndex(activeGlobalIndex);
        const approachSegment = plan.getSegment(activeSegIndex);
        const activeSegLegIndex = activeGlobalIndex - approachSegment.offset;
        const activeLegDef = approachSegment.legs[activeSegLegIndex];
        const prevLegDef = activeSegLegIndex > 0 ? approachSegment.legs[activeSegLegIndex - 1] : null;
        const tailDefs = approachSegment.legs.slice(activeSegLegIndex);

        // Capture start geometry & initial course before mutating segments
        let anchorLat;
        let anchorLon;
        if (activeLegDef.calculated && typeof activeLegDef.calculated.startLat === 'number' && typeof activeLegDef.calculated.startLon === 'number') {
            anchorLat = activeLegDef.calculated.startLat;
            anchorLon = activeLegDef.calculated.startLon;
        } else if (activeLegDef.calculated && activeLegDef.calculated.flightPath && activeLegDef.calculated.flightPath.length > 0) {
            anchorLat = activeLegDef.calculated.flightPath[0].startLat;
            anchorLon = activeLegDef.calculated.flightPath[0].startLon;
        } else if (prevLegDef && prevLegDef.calculated && typeof prevLegDef.calculated.endLat === 'number' && typeof prevLegDef.calculated.endLon === 'number') {
            anchorLat = prevLegDef.calculated.endLat;
            anchorLon = prevLegDef.calculated.endLon;
        } else if (prevLegDef && prevLegDef.calculated && prevLegDef.calculated.flightPath && prevLegDef.calculated.flightPath.length > 0) {
            const lastVec = prevLegDef.calculated.flightPath[prevLegDef.calculated.flightPath.length - 1];
            anchorLat = lastVec.endLat;
            anchorLon = lastVec.endLon;
        } else if (prevLegDef && prevLegDef.leg && typeof prevLegDef.leg.lat === 'number' && typeof prevLegDef.leg.lon === 'number') {
            anchorLat = prevLegDef.leg.lat;
            anchorLon = prevLegDef.leg.lon;
        }

        let initialDfCourse;
        if (sdk.FlightPathUtils) {
            if (activeLegDef.calculated && activeLegDef.calculated.flightPath && activeLegDef.calculated.flightPath.length > 0
                && typeof sdk.FlightPathUtils.getVectorInitialCourse === 'function') {
                initialDfCourse = sdk.FlightPathUtils.getVectorInitialCourse(activeLegDef.calculated.flightPath[0]);
            }
            if ((initialDfCourse === undefined || isNaN(initialDfCourse))
                && prevLegDef && prevLegDef.calculated && prevLegDef.calculated.flightPath && prevLegDef.calculated.flightPath.length > 0
                && typeof sdk.FlightPathUtils.getLegFinalCourse === 'function') {
                initialDfCourse = sdk.FlightPathUtils.getLegFinalCourse(prevLegDef.calculated);
            }
        }

        // Clear any stale Direct-To data pointing into the old approach segment
        if (plan.directToData && plan.directToData.segmentIndex === activeSegIndex) {
            plan.setDirectToData(-1);
        }

        // If an Arrival (STAR) was previously flown before the missed approach, remove it so it
        // does not end up ahead of the Enroute hold we are about to place at the end of Enroute.
        if (clearStaleArrival && plan.procedureDetails && plan.procedureDetails.arrivalIndex >= 0) {
            plan.setArrival();
            const arrSegments = Array.from(plan.segmentsOfType(sdk.FlightPlanSegmentType.Arrival));
            for (let i = arrSegments.length - 1; i >= 0; i--) {
                plan.removeSegment(arrSegments[i].segmentIndex);
            }
        }

        let enrouteSegIndex = fms.findLastEnrouteSegmentIndex(plan);
        let enrouteSegment = plan.tryGetSegment(enrouteSegIndex);
        if (!enrouteSegment || enrouteSegment.segmentType !== sdk.FlightPlanSegmentType.Enroute || enrouteSegment.airway !== undefined) {
            const insertIdx = enrouteSegment ? enrouteSegIndex + 1 : 1;
            enrouteSegment = fms.planInsertSegment(insertIdx, sdk.FlightPlanSegmentType.Enroute);
            enrouteSegIndex = enrouteSegment.segmentIndex;
        }

        const Lt = sdk.LegType;
        const dtoFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.DirectTo) ? sdk.LegDefinitionFlags.DirectTo : 1;
        const legType = activeLegDef.leg.type;
        let firstAddedDef = null;
        let newActiveDef = null;
        let lastAddedDef = null;

        if (tailDefs.length === 1 && isHoldLegType(legType)) {
            if (enrouteSegment.legs.length > 0 || plan.getPrevLeg(enrouteSegIndex, 0) !== null) {
                const discoDef = plan.addLeg(enrouteSegIndex, sdk.FlightPlan.createLeg({ type: Lt.Discontinuity }));
                if (!firstAddedDef) {
                    firstAddedDef = discoDef;
                }
            }

            const transMode = (typeof SimVar !== 'undefined')
                ? Number(SimVar.GetSimVarValue('L:WTAP_LNav_Transition_Mode', 'number') || 0)
                : 0;
            const ingressMode = (sdk.LNavTransitionMode && sdk.LNavTransitionMode.Ingress !== undefined)
                ? sdk.LNavTransitionMode.Ingress
                : 1;
            let parentFixLeg = null;

            if (transMode === ingressMode
                && prevLegDef
                && prevLegDef.calculated
                && prevLegDef.calculated.flightPath
                && prevLegDef.calculated.flightPath.length > 0
                && sdk.FlightPathUtils
                && typeof sdk.FlightPathUtils.getLegFinalCourse === 'function') {
                const entryTrueCourse = sdk.FlightPathUtils.getLegFinalCourse(prevLegDef.calculated);
                if (entryTrueCourse !== undefined && !isNaN(entryTrueCourse)) {
                    parentFixLeg = sdk.FlightPlan.createLeg({
                        type: Lt.CF,
                        fixIcao: activeLegDef.leg.fixIcao,
                        course: entryTrueCourse,
                        trueDegrees: true
                    });
                }
            }

            if (!parentFixLeg) {
                parentFixLeg = sdk.FlightPlan.createLeg({
                    type: Lt.IF,
                    fixIcao: activeLegDef.leg.fixIcao
                });
            }

            const parentDef = plan.addLeg(enrouteSegIndex, parentFixLeg);
            if (!firstAddedDef) {
                firstAddedDef = parentDef;
            }

            const holdLegCopy = sdk.FlightPlan.createLeg(activeLegDef.leg);
            holdLegCopy.type = Lt.HM;
            if (sdk.FixTypeFlags && sdk.FixTypeFlags.MAHP) {
                holdLegCopy.fixTypeFlags &= ~sdk.FixTypeFlags.MAHP;
            }
            newActiveDef = plan.addLeg(enrouteSegIndex, holdLegCopy);
            if (activeLegDef.calculated) {
                newActiveDef.calculated = cloneLegCalculations(activeLegDef.calculated);
            }
            const newSegLegIndex = enrouteSegment.legs.indexOf(newActiveDef);
            if (newSegLegIndex >= 0) {
                plan.setLegUserData(enrouteSegIndex, newSegLegIndex, 'wt_relocated_mapr_hold', true);
            }
            lastAddedDef = newActiveDef;
        } else {
            if (enrouteSegment.legs.length > 0 || plan.getPrevLeg(enrouteSegIndex, 0) !== null) {
                const discoDef = plan.addLeg(enrouteSegIndex, sdk.FlightPlan.createLeg({ type: Lt.Discontinuity }), undefined, dtoFlag);
                if (!firstAddedDef) {
                    firstAddedDef = discoDef;
                }
            }

            if (legType === Lt.FM && prevLegDef && prevLegDef.leg && isFacilityIcao(prevLegDef.leg.fixIcao)) {
                const fmOriginDef = plan.addLeg(enrouteSegIndex, sdk.FlightPlan.createLeg({
                    type: Lt.IF,
                    fixIcao: prevLegDef.leg.fixIcao
                }), undefined, dtoFlag);
                if (!firstAddedDef) {
                    firstAddedDef = fmOriginDef;
                }
            } else if (legType !== Lt.IF) {
                if (typeof anchorLat === 'number' && !isNaN(anchorLat) && typeof anchorLon === 'number' && !isNaN(anchorLon)) {
                    const anchorIfDef = plan.addLeg(enrouteSegIndex, sdk.FlightPlan.createLeg({
                        type: Lt.IF,
                        lat: anchorLat,
                        lon: anchorLon
                    }), undefined, dtoFlag);
                    if (!firstAddedDef) {
                        firstAddedDef = anchorIfDef;
                    }
                } else if (prevLegDef && prevLegDef.leg && isFacilityIcao(prevLegDef.leg.fixIcao)) {
                    const anchorFixDef = plan.addLeg(enrouteSegIndex, sdk.FlightPlan.createLeg({
                        type: Lt.IF,
                        fixIcao: prevLegDef.leg.fixIcao
                    }), undefined, dtoFlag);
                    if (!firstAddedDef) {
                        firstAddedDef = anchorFixDef;
                    }
                }
            }

            const isDiscontinuityLeg = function (t) {
                if (sdk.FlightPlanUtils && typeof sdk.FlightPlanUtils.isDiscontinuityLeg === 'function') {
                    return sdk.FlightPlanUtils.isDiscontinuityLeg(t);
                }
                return t === Lt.Discontinuity || t === Lt.ThruDiscontinuity;
            };

            for (let k = 0; k < tailDefs.length; k++) {
                const srcDef = tailDefs[k];
                if (!srcDef || !srcDef.leg) {
                    continue;
                }
                if (k > 0 && ((srcDef.flags & dtoFlag) === dtoFlag) && (isDiscontinuityLeg(srcDef.leg.type) || !isFacilityIcao(srcDef.leg.fixIcao))) {
                    continue;
                }

                const legCopy = sdk.FlightPlan.createLeg(srcDef.leg);
                if (k === 0 && legCopy.type === Lt.DF && legCopy.course === 0 && initialDfCourse !== undefined && !isNaN(initialDfCourse)) {
                    const normCourse = ((initialDfCourse % 360) + 360) % 360;
                    legCopy.course = normCourse === 0 ? 360 : normCourse;
                    legCopy.trueDegrees = true;
                }
                if (sdk.FixTypeFlags && sdk.FixTypeFlags.MAHP) {
                    legCopy.fixTypeFlags &= ~sdk.FixTypeFlags.MAHP;
                }
                if (isHoldLegType(legCopy.type)) {
                    legCopy.type = Lt.HM;
                }

                const addedDef = plan.addLeg(enrouteSegIndex, legCopy);
                if (srcDef.calculated) {
                    addedDef.calculated = cloneLegCalculations(srcDef.calculated);
                }
                if (!firstAddedDef) {
                    firstAddedDef = addedDef;
                }
                const addedSegLegIdx = enrouteSegment.legs.indexOf(addedDef);
                if (addedSegLegIdx >= 0) {
                    plan.setLegUserData(enrouteSegIndex, addedSegLegIdx, 'wt_relocated_mapr_hold', true);
                    if (newActiveDef === null && !isHoldLegType(legCopy.type)) {
                        plan.setLegUserData(enrouteSegIndex, addedSegLegIdx, 'wt_relocated_mapr_direct_arrow', true);
                    }
                }
                if (newActiveDef === null) {
                    newActiveDef = addedDef;
                }
                lastAddedDef = addedDef;
            }

            if (lastAddedDef && lastAddedDef.leg) {
                const lastType = lastAddedDef.leg.type;
                if (!isHoldLegType(lastType) && lastType !== Lt.FM && lastType !== Lt.VM) {
                    const lastSegIdx = enrouteSegment.legs.indexOf(lastAddedDef);
                    if (lastSegIdx >= 0) {
                        plan.setLegUserData(enrouteSegIndex, lastSegIdx, 'wt_relocated_mapr_suspend_end', true);
                    }
                }
            }
        }

        const calcStartIndex = firstAddedDef ? plan.getLegIndexFromLeg(firstAddedDef) : -1;
        const newGlobalIndex = plan.getLegIndexFromLeg(newActiveDef);
        plan.setCalculatingLeg(calcStartIndex >= 0 ? calcStartIndex : newGlobalIndex);
        plan.setLateralLeg(newGlobalIndex);
    }

    function clearSpentApproachAfterRelocation(fms) {
        try {
            const plan = fms.getPrimaryFlightPlan();
            const garmin = window.garminsdk;
            const UserKey = (garmin && garmin.FmsFplUserDataKey) ? garmin.FmsFplUserDataKey : {};
            plan.setApproach();
            const appSegments = Array.from(plan.segmentsOfType(sdk.FlightPlanSegmentType.Approach));
            for (let i = appSegments.length - 1; i >= 0; i--) {
                plan.removeSegment(appSegments[i].segmentIndex);
            }
            if (UserKey.VisualApproach) plan.deleteUserData(UserKey.VisualApproach);
            if (UserKey.VisualApproachRunway) plan.deleteUserData(UserKey.VisualApproachRunway);
            if (UserKey.VfrApproach) plan.deleteUserData(UserKey.VfrApproach);
            if (UserKey.ApproachSkipCourseReversal) plan.deleteUserData(UserKey.ApproachSkipCourseReversal);
            if (fms.publisher && fms.lnavControlTopicMap && fms.lnavControlTopicMap['activate_missed_approach']) {
                fms.publisher.pub(fms.lnavControlTopicMap['activate_missed_approach'], false, true, true);
            }
            if (typeof fms.updateApproachDetails === 'function') {
                fms.updateApproachDetails();
            }
        } catch (e) {
            console.error('CT182TGfc700Plugin: clearSpentApproachAfterRelocation error', e);
        }
    }

    function patchLNavComputerPrototype() {
        try {
            const LNavComp = sdk && sdk.LNavComputer;
            if (!LNavComp || !LNavComp.prototype || LNavComp.prototype._wtHoldRelocPatched) {
                return;
            }
            LNavComp.prototype._wtHoldRelocPatched = true;

            const origResetVectors = LNavComp.prototype.resetVectors;
            LNavComp.prototype.resetVectors = function () {
                try {
                    const fp = (this.flightPlanner && typeof this.flightPlanner.hasActiveFlightPlan === 'function' && this.flightPlanner.hasActiveFlightPlan())
                        ? this.flightPlanner.getActiveFlightPlan()
                        : null;
                    const oldLeg = this.currentLeg;
                    const newLeg = fp ? fp.tryGetLeg(fp.activeLateralLeg) : null;

                    if (fp && oldLeg && newLeg && this.currentState) {
                        const explicitTs = (newLeg.userData && newLeg.userData['wt_explicit_activate_ts']) || 0;
                        const isExplicitActivation = (Date.now() - explicitTs) < 500;

                        if (!isExplicitActivation) {
                            const isSameLegObj = (oldLeg === newLeg);
                            const missedFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.MissedApproach) ? sdk.LegDefinitionFlags.MissedApproach : 2;
                            const isRelocatedFromMissed = (oldLeg !== newLeg)
                                && !!(newLeg.userData && newLeg.userData['wt_relocated_mapr_hold'])
                                && ((oldLeg.flags & missedFlag) === missedFlag);

                            const legType = newLeg.leg && newLeg.leg.type;
                            const Lt = sdk.LegType || {};
                            const isHoldOrManual = isHoldLegType(legType)
                                || legType === Lt.VM
                                || legType === Lt.FM
                                || !!(newLeg.userData && newLeg.userData['wt_relocated_mapr_hold']);

                            if (isHoldOrManual && (isSameLegObj || isRelocatedFromMissed)) {
                                let savedVecIdx = this.currentState.vectorIndex;
                                const savedTransMode = this.currentState.transitionMode;
                                const savedSuspended = this.currentState.isSuspended;

                                origResetVectors.apply(this, arguments);

                                if (newLeg.calculated && sdk.LNavUtils && typeof sdk.LNavUtils.getVectorsForTransitionMode === 'function') {
                                    const vecs = sdk.LNavUtils.getVectorsForTransitionMode(newLeg.calculated, savedTransMode, savedSuspended);
                                    if (vecs && vecs.length > 0 && savedVecIdx >= vecs.length) {
                                        savedVecIdx = vecs.length - 1;
                                    }
                                }
                                this.currentState.vectorIndex = savedVecIdx;
                                this.currentState.transitionMode = savedTransMode;
                                this.currentState.isSuspended = savedSuspended;
                                if (savedSuspended && (legType === Lt.VM || legType === Lt.FM)) {
                                    this.currentState.inhibitedSuspendLegIndex = fp.activeLateralLeg;
                                }
                                return;
                            }
                        }
                    }
                } catch (e) {}
                return origResetVectors.apply(this, arguments);
            };

            if (typeof LNavComp.prototype.applyEndOfLegSuspends === 'function') {
                const origApplyEndSusp = LNavComp.prototype.applyEndOfLegSuspends;
                LNavComp.prototype.applyEndOfLegSuspends = function (plan, state, out) {
                    const res = origApplyEndSusp.call(this, plan, state, out);
                    try {
                        if (res && !res.isSuspended && plan && typeof plan.tryGetLeg === 'function') {
                            const leg = plan.tryGetLeg(res.globalLegIndex);
                            if (leg && leg.userData && leg.userData['wt_relocated_mapr_suspend_end']) {
                                return this.trySetSuspended(plan, res, true, res, true, false);
                            }
                        }
                    } catch (e) {}
                    return res;
                };
            }
        } catch (e) {}
    }

    function patchFmsUtilsArrowDisplay() {
        try {
            const garmin = window.garminsdk;
            const FmsUtils = garmin && garmin.FmsUtils;
            if (!FmsUtils || typeof FmsUtils.getFromLegForArrowDisplay !== 'function' || FmsUtils._wtArrowDisplayPatched) {
                return;
            }
            FmsUtils._wtArrowDisplayPatched = true;
            const origGetFromLeg = FmsUtils.getFromLegForArrowDisplay.bind(FmsUtils);
            FmsUtils.getFromLegForArrowDisplay = function (plan, arg2, arg3) {
                try {
                    if (plan && typeof plan.tryGetLeg === 'function') {
                        const toLeg = arg3 === undefined ? plan.tryGetLeg(arg2) : plan.tryGetLeg(arg2, arg3);
                        if (toLeg && toLeg.userData && toLeg.userData['wt_relocated_mapr_direct_arrow']) {
                            return undefined;
                        }
                    }
                } catch (e) {}
                return origGetFromLeg(plan, arg2, arg3);
            };
        } catch (e) {}
    }

    function patchSelectApproachUi() {
        try {
            const mods = [window.g1000nxipfd, window.g1000nximfd];
            for (let i = 0; i < mods.length; i++) {
                const mod = mods[i];
                if (!mod) {
                    continue;
                }

                const Ctrl = mod.SelectApproachController;
                if (Ctrl && Ctrl.prototype && !Ctrl.prototype._wtMissedApprUiPatched) {
                    Ctrl.prototype._wtMissedApprUiPatched = true;

                    const ensureLiveCanLoadSub = function (ctrl) {
                        if (ctrl._wtLiveCanLoadWired || !ctrl.fms || !ctrl.canLoad || !ctrl.store) {
                            return;
                        }
                        ctrl._wtLiveCanLoadWired = true;
                        const refreshCanLoad = function () {
                            try {
                                const valid = !!ctrl.store.selectedProcedure.get();
                                ctrl.canLoad.set(valid && ctrl.fms.canApproachLoad());
                            } catch (e) {}
                        };
                        ctrl._wtRefreshCanLoad = refreshCanLoad;
                        try {
                            if (ctrl.fms.flightPlanner && typeof ctrl.fms.flightPlanner.onEvent === 'function') {
                                ctrl.fms.flightPlanner.onEvent('fplActiveLegChange').handle(refreshCanLoad);
                                ctrl.fms.flightPlanner.onEvent('fplSegmentChange').handle(refreshCanLoad);
                                ctrl.fms.flightPlanner.onEvent('fplIndexChanged').handle(refreshCanLoad);
                            }
                            if (ctrl.bus && typeof ctrl.bus.getSubscriber === 'function') {
                                const sub = ctrl.bus.getSubscriber();
                                sub.on('lnav_tracking_state').handle(refreshCanLoad);
                            }
                        } catch (e) {}
                    };

                    if (typeof Ctrl.prototype.initialize === 'function') {
                        const origInit = Ctrl.prototype.initialize;
                        Ctrl.prototype.initialize = function () {
                            ensureLiveCanLoadSub(this);
                            const res = origInit.apply(this, arguments);
                            if (typeof this._wtRefreshCanLoad === 'function') {
                                this._wtRefreshCanLoad();
                            }
                            return res;
                        };
                    }

                    if (typeof Ctrl.prototype.onApproachSelected === 'function') {
                        const origOnApprSel = Ctrl.prototype.onApproachSelected;
                        Ctrl.prototype.onApproachSelected = function () {
                            ensureLiveCanLoadSub(this);
                            return origOnApprSel.apply(this, arguments);
                        };
                    }
                }

                const View = mod.SelectApproach;
                if (View && View.prototype && !View.prototype._wtMissedApprViewPatched) {
                    View.prototype._wtMissedApprViewPatched = true;
                    if (typeof View.prototype.onActivated === 'function') {
                        const origOnActivated = View.prototype.onActivated;
                        View.prototype.onActivated = function () {
                            const res = origOnActivated.apply(this, arguments);
                            try {
                                if (this.controller && this.controller.canLoad && this.controller.store && this.controller.fms) {
                                    const valid = !!this.controller.store.selectedProcedure.get();
                                    this.controller.canLoad.set(valid && this.controller.fms.canApproachLoad());
                                }
                            } catch (e) {}
                            return res;
                        };
                    }
                }
            }
        } catch (e) {}
    }

    function prepareDormantPrimaryForRandomDirectLoad(fms) {
        try {
            const plan = fms.getPrimaryFlightPlan();
            const activeIdx = plan.activeLateralLeg;
            if (activeIdx >= 0 && activeIdx < plan.length) {
                const seg = plan.getSegment(plan.getSegmentIndex(activeIdx));
                if (seg && seg.segmentType === sdk.FlightPlanSegmentType.Approach && seg.offset > 0) {
                    plan.setCalculatingLeg(seg.offset - 1);
                    plan.setLateralLeg(seg.offset - 1);
                }
            }
        } catch (e) {}
    }

    function installFmsMissedApproachFix(fms) {
        if (!fms || fms._wtMissedApprLoadPatched) {
            return;
        }
        fms._wtMissedApprLoadPatched = true;

        const origCanApproachLoad = fms.canApproachLoad.bind(fms);
        fms.canApproachLoad = function () {
            if (origCanApproachLoad()) {
                return true;
            }
            if (isPastLastFixInMissedApproach(fms)) {
                return true;
            }
            return isDirectToRandomWithLoadablePrimary(fms);
        };

        if (typeof fms.activateVtf === 'function') {
            const origActivateVtf = fms.activateVtf.bind(fms);
            fms.activateVtf = async function () {
                fms._inActivateVtf = true;
                try {
                    return await origActivateVtf.apply(this, arguments);
                } finally {
                    fms._inActivateVtf = false;
                }
            };
        }

        if (typeof fms._activateLeg === 'function') {
            const origActivateLeg = fms._activateLeg.bind(fms);
            fms._activateLeg = function (planIndex, segmentIndex, segmentLegIndex, inhibitImmediateSequence) {
                try {
                    const plan = fms.hasFlightPlan(planIndex) ? fms.getFlightPlan(planIndex) : null;
                    const leg = plan ? plan.tryGetLeg(segmentIndex, segmentLegIndex) : null;
                    if (leg && leg.userData) {
                        leg.userData['wt_explicit_activate_ts'] = Date.now();
                    }
                } catch (e) {}
                return origActivateLeg(planIndex, segmentIndex, segmentLegIndex, inhibitImmediateSequence);
            };
        }

        if (typeof fms.manageAirportLeg === 'function') {
            const origManageAirportLeg = fms.manageAirportLeg.bind(fms);
            fms.manageAirportLeg = function (plan, currentDestination) {
                if (fms._suppressManageAirportLeg) {
                    return;
                }
                try {
                    const lastEnrIdx = fms.findLastEnrouteSegmentIndex(plan);
                    const seg = plan.tryGetSegment(lastEnrIdx);
                    if (seg && seg.legs.length > 0) {
                        const lastLeg = seg.legs[seg.legs.length - 1];
                        if (lastLeg && lastLeg.userData && lastLeg.userData['wt_relocated_mapr_hold']) {
                            return;
                        }
                    }
                } catch (e) {}
                return origManageAirportLeg(plan, currentDestination);
            };
        }

        if (typeof fms.planRemoveDuplicateLeg === 'function') {
            const origRemoveDup = fms.planRemoveDuplicateLeg.bind(fms);
            fms.planRemoveDuplicateLeg = function (leg1, leg2) {
                if (leg1 && leg1.userData && leg1.userData['wt_relocated_mapr_hold']) {
                    return null;
                }
                return origRemoveDup(leg1, leg2);
            };
        }

        if (typeof fms.insertApproach === 'function') {
            const origInsertApproach = fms.insertApproach.bind(fms);
            fms.insertApproach = async function (facility, approachIndex, approachTransitionIndex, visualRunwayNumber, visualRunwayDesignator, skipCourseReversal = false, activate = false) {
                if (!activate && !fms._inActivateVtf) {
                    if (isPastLastFixInMissedApproach(fms)) {
                        relocateActiveMissedLegToEnroute(fms, true);
                        fms._suppressManageAirportLeg = true;
                        try {
                            return await origInsertApproach(facility, approachIndex, approachTransitionIndex, visualRunwayNumber, visualRunwayDesignator, skipCourseReversal, false);
                        } finally {
                            fms._suppressManageAirportLeg = false;
                        }
                    }
                    if (isDirectToRandomWithLoadablePrimary(fms)) {
                        prepareDormantPrimaryForRandomDirectLoad(fms);
                    }
                }
                return origInsertApproach(facility, approachIndex, approachTransitionIndex, visualRunwayNumber, visualRunwayDesignator, skipCourseReversal, activate);
            };
        }

        if (typeof fms.insertVfrApproach === 'function') {
            const origInsertVfrApproach = fms.insertVfrApproach.bind(fms);
            fms.insertVfrApproach = async function (facility, approachIndex, isVtf, activate = false) {
                if (!activate && !fms._inActivateVtf) {
                    if (isPastLastFixInMissedApproach(fms)) {
                        relocateActiveMissedLegToEnroute(fms, true);
                        fms._suppressManageAirportLeg = true;
                        try {
                            return await origInsertVfrApproach(facility, approachIndex, isVtf, false);
                        } finally {
                            fms._suppressManageAirportLeg = false;
                        }
                    }
                    if (isDirectToRandomWithLoadablePrimary(fms)) {
                        prepareDormantPrimaryForRandomDirectLoad(fms);
                    }
                }
                return origInsertVfrApproach(facility, approachIndex, isVtf, activate);
            };
        }

        if (typeof fms.insertArrival === 'function') {
            const origInsertArrival = fms.insertArrival.bind(fms);
            fms.insertArrival = function (facility, arrivalIndex, arrivalRunwayTransitionIndex, enrouteTransitionIndex, arrivalRunway) {
                if (isPastLastFixInMissedApproach(fms)) {
                    relocateActiveMissedLegToEnroute(fms, true);
                    clearSpentApproachAfterRelocation(fms);
                }
                return origInsertArrival(facility, arrivalIndex, arrivalRunwayTransitionIndex, enrouteTransitionIndex, arrivalRunway);
            };
        }
    }

    if (shouldInstallG1000Enhancements) {
        patchLNavComputerPrototype();
        patchFmsUtilsArrowDisplay();
        patchSelectApproachUi();
    }

    // =========================================================================
    // 1B. WTG1000 NXi Waypoint Selection Submenu (PFD & MFD)
    //     Real Garmin G1000 NXi behavior (190-02177-00 Rev. A, Fig. 5-46,
    //     pp. 19, 173-174, 180, 187-188, 218, 223):
    //     Turning the small FMS knob counter-clockwise on a focused Waypoint
    //     input field (or on an FPL row) opens the Waypoint Submenu with four
    //     tabs: Flight Plan -> Nearest -> Recent -> User.
    // =========================================================================

    const SUBMENU_TABS = ['Flight Plan', 'Nearest', 'Recent', 'User'];
    const SUBMENU_VISIBLE_ROWS = 7;
    const MAX_RECENT_WAYPOINTS = 25;
    const MAX_NEAREST_WAYPOINTS = 25;
    const NEAREST_RADIUS_METERS = 370400; // 200 NM
    const RECENT_STORAGE_KEY = 'WTG1000_NXI_RECENT_WAYPOINTS_V1';

    const isMfdContext = !!window.g1000nximfd;
    const isPfdContext = !!window.g1000nxipfd && !isMfdContext;

    let submenuFms = null;
    let submenuBus = null;
    let submenuViewService = null;
    let sharedFacLoader = null;
    let autoOpenSubmenuUntil = 0;

    let planeLat = NaN;
    let planeLon = NaN;
    const nearestSessions = new Map(); // searchType -> { sessionPromise, knownIcaos, sortedItems, lastRefreshMs, lastLat, lastLon, inFlight }
    let cachedUserItems = [];
    let recentIcaos = [];

    const activeSubmenuState = {
        isOpen: false,
        inputComp: null,
        wptInput: null,
        mod: null,
        tabIndex: 0,
        items: [],
        selectedIndex: -1,
        scrollTop: 0,
        savedIcao: '',
        savedRawText: '',
        domRoot: null,
        domLeftArrow: null,
        domRightArrow: null,
        domTabBox: null,
        domList: null,
        domScrollbar: null,
        domThumb: null
    };

    function safeSetSimVar(name, unit, value) {
        try {
            if (typeof SimVar !== 'undefined' && typeof SimVar.SetSimVarValue === 'function') {
                SimVar.SetSimVarValue(name, unit, value);
            }
        } catch (e) {}
    }

    function publishSubmenuDiagnostics() {
        const prefix = isMfdContext ? 'L:CT182T_MFD_SUB_' : 'L:CT182T_PFD_SUB_';
        safeSetSimVar(prefix + 'OPEN', 'Number', activeSubmenuState.isOpen ? 1 : 0);
        safeSetSimVar(prefix + 'TAB', 'Number', activeSubmenuState.isOpen ? activeSubmenuState.tabIndex : -1);
        safeSetSimVar(prefix + 'CNT', 'Number', activeSubmenuState.isOpen ? activeSubmenuState.items.length : 0);
        safeSetSimVar(prefix + 'IDX', 'Number', activeSubmenuState.isOpen ? activeSubmenuState.selectedIndex : -1);
    }

    function publishFlightPlanDiagnostics() {
        if (!isMfdContext || !submenuFms) {
            return;
        }
        try {
            if (typeof submenuFms.hasPrimaryFlightPlan === 'function' && submenuFms.hasPrimaryFlightPlan()) {
                const plan = submenuFms.getPrimaryFlightPlan();
                safeSetSimVar('L:CT182T_DBG_FPL_LEN', 'Number', Number(plan.length || 0));
                safeSetSimVar('L:CT182T_DBG_HAS_ORIG', 'Number', plan.originAirport ? 1 : 0);
                safeSetSimVar('L:CT182T_DBG_HAS_DEST', 'Number', plan.destinationAirport ? 1 : 0);
                const apprIdx = (plan.procedureDetails && typeof plan.procedureDetails.approachIndex === 'number')
                    ? plan.procedureDetails.approachIndex
                    : -1;
                safeSetSimVar('L:CT182T_DBG_APPR_IDX', 'Number', apprIdx);
            }
        } catch (e) {}
    }

    function isSelectableWaypointIcao(icao) {
        if (!icao || typeof icao !== 'string') {
            return false;
        }
        if (!sdk || !sdk.ICAO || typeof sdk.ICAO.isFacility !== 'function' || !sdk.ICAO.isFacility(icao)) {
            return false;
        }
        const FT = sdk.FacilityType || {};
        const ft = sdk.ICAO.getFacilityType(icao);
        if (FT.RWY !== undefined && ft === FT.RWY) {
            return false;
        }
        if (FT.VIS !== undefined && ft === FT.VIS) {
            return false;
        }
        const ident = typeof sdk.ICAO.getIdent === 'function' ? sdk.ICAO.getIdent(icao).trim() : '';
        return ident.length > 0;
    }

    function matchesSearchFilter(icao, filter) {
        if (!isSelectableWaypointIcao(icao)) {
            return false;
        }
        const FST = sdk.FacilitySearchType || {};
        const FT = sdk.FacilityType || {};
        const ft = sdk.ICAO.getFacilityType(icao);
        if (filter === FST.Airport) {
            return ft === FT.Airport;
        }
        if (filter === FST.Intersection) {
            return ft === FT.Intersection;
        }
        if (filter === FST.Vor) {
            return ft === FT.VOR;
        }
        if (filter === FST.Ndb) {
            return ft === FT.NDB;
        }
        if (filter === FST.User) {
            return ft === FT.USR;
        }
        return true;
    }

    function loadRecentFromStorage() {
        try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
                const raw = localStorage.getItem(RECENT_STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        const merged = [];
                        const seen = new Set();
                        for (let i = 0; i < parsed.length; i++) {
                            const ic = parsed[i];
                            if (isSelectableWaypointIcao(ic) && !seen.has(ic)) {
                                seen.add(ic);
                                merged.push(ic);
                            }
                        }
                        for (let i = 0; i < recentIcaos.length; i++) {
                            const ic = recentIcaos[i];
                            if (isSelectableWaypointIcao(ic) && !seen.has(ic)) {
                                seen.add(ic);
                                merged.push(ic);
                            }
                        }
                        recentIcaos = merged.slice(0, MAX_RECENT_WAYPOINTS);
                    }
                }
            }
        } catch (e) {}
    }

    function saveRecentToStorage() {
        try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
                localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentIcaos));
            }
        } catch (e) {}
    }

    function recordRecentIcao(icao) {
        if (!isSelectableWaypointIcao(icao)) {
            return;
        }
        loadRecentFromStorage();
        const next = [icao];
        for (let i = 0; i < recentIcaos.length; i++) {
            if (recentIcaos[i] !== icao) {
                next.push(recentIcaos[i]);
            }
            if (next.length >= MAX_RECENT_WAYPOINTS) {
                break;
            }
        }
        recentIcaos = next;
        saveRecentToStorage();
    }

    function seedRecentFromFlightPlan(fms) {
        try {
            if (!fms || typeof fms.hasPrimaryFlightPlan !== 'function' || !fms.hasPrimaryFlightPlan()) {
                return;
            }
            loadRecentFromStorage();
            const plan = fms.getPrimaryFlightPlan();
            const cands = [];
            if (plan.originAirport) {
                cands.push(plan.originAirport);
            }
            if (typeof plan.legs === 'function') {
                for (const legDef of plan.legs()) {
                    if (legDef && legDef.leg && legDef.leg.fixIcao) {
                        cands.push(legDef.leg.fixIcao);
                    }
                }
            }
            if (plan.destinationAirport) {
                cands.push(plan.destinationAirport);
            }
            const seen = new Set(recentIcaos);
            for (let i = 0; i < cands.length; i++) {
                const ic = cands[i];
                if (isSelectableWaypointIcao(ic) && !seen.has(ic) && recentIcaos.length < MAX_RECENT_WAYPOINTS) {
                    seen.add(ic);
                    recentIcaos.push(ic);
                }
            }
            saveRecentToStorage();
        } catch (e) {}
    }

    function getPlaneCoordinates() {
        if (!isNaN(planeLat) && !isNaN(planeLon) && !(planeLat === 0 && planeLon === 0)) {
            return { lat: planeLat, lon: planeLon };
        }
        try {
            if (typeof SimVar !== 'undefined' && typeof SimVar.GetSimVarValue === 'function') {
                const lat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees'));
                const lon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees'));
                if (!isNaN(lat) && !isNaN(lon) && !(lat === 0 && lon === 0)) {
                    planeLat = lat;
                    planeLon = lon;
                    return { lat: lat, lon: lon };
                }
            }
        } catch (e) {}
        return null;
    }

    function computeDistanceRad(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
        const toRad = Math.PI / 180;
        const dLat = (lat2Deg - lat1Deg) * toRad;
        const dLon = (lon2Deg - lon1Deg) * toRad;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(lat1Deg * toRad) * Math.cos(lat2Deg * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function getFacilityLoader(wptInput) {
        if (wptInput && wptInput.store && wptInput.store.facLoader) {
            if (!sharedFacLoader) {
                sharedFacLoader = wptInput.store.facLoader;
            }
            return wptInput.store.facLoader;
        }
        if (sharedFacLoader) {
            return sharedFacLoader;
        }
        if (submenuFms && submenuFms.facLoader) {
            sharedFacLoader = submenuFms.facLoader;
            return sharedFacLoader;
        }
        if (submenuBus && sdk.FacilityRepository && sdk.FacilityLoader) {
            try {
                sharedFacLoader = new sdk.FacilityLoader(sdk.FacilityRepository.getRepository(submenuBus));
                return sharedFacLoader;
            } catch (e) {}
        }
        return null;
    }

    function getNearestSearchTypeForFilter(filter) {
        const FST = sdk.FacilitySearchType || {};
        if (filter === FST.Intersection || filter === FST.Vor || filter === FST.Ndb || filter === FST.User) {
            return filter;
        }
        return FST.Airport !== undefined ? FST.Airport : 1;
    }

    function refreshNearestForType(searchType, wptInput, force, onUpdated) {
        const facLoader = getFacilityLoader(wptInput);
        if (!facLoader || typeof facLoader.startNearestSearchSession !== 'function') {
            return;
        }
        const pos = getPlaneCoordinates();
        if (!pos) {
            return;
        }

        let entry = nearestSessions.get(searchType);
        if (!entry) {
            const FST = sdk.FacilitySearchType || {};
            const sessionPromise = Promise.resolve(facLoader.startNearestSearchSession(searchType)).then(function (session) {
                if (session && searchType === (FST.Airport !== undefined ? FST.Airport : 1) && typeof session.setAirportFilter === 'function') {
                    const ACM = sdk.AirportClassMask || {};
                    const mask = (ACM.HardSurface || 1) | (ACM.SoftSurface || 2) | (ACM.AllWater || 4) | (ACM.HelipadOnly || 8);
                    try {
                        session.setAirportFilter(false, mask);
                    } catch (e) {}
                }
                return session;
            }).catch(function () {
                return null;
            });

            entry = {
                sessionPromise: sessionPromise,
                knownIcaos: new Set(),
                sortedItems: [],
                lastRefreshMs: 0,
                lastLat: NaN,
                lastLon: NaN,
                inFlight: false,
                pendingCallbacks: []
            };
            nearestSessions.set(searchType, entry);
        }

        if (typeof onUpdated === 'function') {
            entry.pendingCallbacks.push(onUpdated);
        }

        const flushCallbacks = function () {
            const cbs = entry.pendingCallbacks.splice(0, entry.pendingCallbacks.length);
            for (let i = 0; i < cbs.length; i++) {
                try {
                    cbs[i](entry.sortedItems);
                } catch (e) {}
            }
        };

        const now = Date.now();
        if (!force && entry.sortedItems.length > 0 && (now - entry.lastRefreshMs) < 10000) {
            if (!isNaN(entry.lastLat) && computeDistanceRad(pos.lat, pos.lon, entry.lastLat, entry.lastLon) < 0.0003) {
                flushCallbacks();
                return;
            }
        }
        if (entry.inFlight) {
            return;
        }
        entry.inFlight = true;

        entry.sessionPromise.then(function (session) {
            if (!session || typeof session.searchNearest !== 'function') {
                entry.inFlight = false;
                flushCallbacks();
                return;
            }
            return Promise.resolve(session.searchNearest(pos.lat, pos.lon, NEAREST_RADIUS_METERS, 60)).then(function (diff) {
                if (diff) {
                    if (Array.isArray(diff.added)) {
                        for (let i = 0; i < diff.added.length; i++) {
                            if (isSelectableWaypointIcao(diff.added[i])) {
                                entry.knownIcaos.add(diff.added[i]);
                            }
                        }
                    }
                    if (Array.isArray(diff.removed)) {
                        for (let i = 0; i < diff.removed.length; i++) {
                            entry.knownIcaos.delete(diff.removed[i]);
                        }
                    }
                }

                const icaoList = Array.from(entry.knownIcaos);
                return Promise.all(icaoList.map(function (icao) {
                    return Promise.resolve(facLoader.getFacility(sdk.ICAO.getFacilityType(icao), icao)).then(function (fac) {
                        if (!fac || typeof fac.lat !== 'number' || typeof fac.lon !== 'number') {
                            return null;
                        }
                        return {
                            icao: icao,
                            ident: sdk.ICAO.getIdent(icao).trim(),
                            dist: computeDistanceRad(pos.lat, pos.lon, fac.lat, fac.lon)
                        };
                    }).catch(function () {
                        return null;
                    });
                }));
            }).then(function (loaded) {
                entry.inFlight = false;
                if (!Array.isArray(loaded)) {
                    flushCallbacks();
                    return;
                }
                const valid = [];
                for (let i = 0; i < loaded.length; i++) {
                    if (loaded[i] && loaded[i].ident) {
                        valid.push(loaded[i]);
                    }
                }
                valid.sort(function (a, b) {
                    return a.dist - b.dist;
                });
                entry.sortedItems = valid.slice(0, MAX_NEAREST_WAYPOINTS);
                entry.lastRefreshMs = Date.now();
                entry.lastLat = pos.lat;
                entry.lastLon = pos.lon;
                flushCallbacks();
            });
        }).catch(function () {
            entry.inFlight = false;
            flushCallbacks();
        });
    }

    function refreshUserWaypoints(wptInput, onUpdated) {
        const facLoader = getFacilityLoader(wptInput);
        const FST = sdk.FacilitySearchType || {};
        if (!facLoader || typeof facLoader.searchByIdent !== 'function' || FST.User === undefined) {
            return;
        }
        Promise.resolve(facLoader.searchByIdent(FST.User, '', 100)).then(function (icaos) {
            if (!Array.isArray(icaos)) {
                return;
            }
            const next = [];
            const seen = new Set();
            for (let i = 0; i < icaos.length; i++) {
                const ic = icaos[i];
                if (isSelectableWaypointIcao(ic) && !seen.has(ic)) {
                    seen.add(ic);
                    next.push({ icao: ic, ident: sdk.ICAO.getIdent(ic).trim() });
                }
            }
            cachedUserItems = next;
            if (typeof onUpdated === 'function') {
                onUpdated(cachedUserItems);
            }
        }).catch(function () {});
    }

    function getFlightPlanSubmenuItems(filter) {
        const out = [];
        const seen = new Set();
        const addIcao = function (icao) {
            if (icao && !seen.has(icao) && matchesSearchFilter(icao, filter)) {
                seen.add(icao);
                out.push({ icao: icao, ident: sdk.ICAO.getIdent(icao).trim() });
            }
        };
        try {
            if (submenuFms && typeof submenuFms.hasPrimaryFlightPlan === 'function' && submenuFms.hasPrimaryFlightPlan()) {
                const plan = submenuFms.getPrimaryFlightPlan();
                if (plan.originAirport) {
                    addIcao(plan.originAirport);
                }
                if (typeof plan.legs === 'function') {
                    for (const legDef of plan.legs()) {
                        if (legDef && legDef.leg && legDef.leg.fixIcao) {
                            addIcao(legDef.leg.fixIcao);
                        }
                    }
                }
                if (plan.destinationAirport) {
                    addIcao(plan.destinationAirport);
                }
            }
            if (out.length === 0 && submenuFms && submenuFms.flightPlanner && typeof submenuFms.flightPlanner.hasFlightPlan === 'function' && submenuFms.flightPlanner.hasFlightPlan(1)) {
                const dtoPlan = submenuFms.flightPlanner.getFlightPlan(1);
                if (dtoPlan && typeof dtoPlan.legs === 'function') {
                    for (const legDef of dtoPlan.legs()) {
                        if (legDef && legDef.leg && legDef.leg.fixIcao) {
                            addIcao(legDef.leg.fixIcao);
                        }
                    }
                }
            }
        } catch (e) {}
        return out;
    }

    function getTabItems(tabIndex, wptInput) {
        const filter = (wptInput && wptInput.props) ? wptInput.props.filter : undefined;
        if (tabIndex === 0) {
            return getFlightPlanSubmenuItems(filter);
        }
        if (tabIndex === 1) {
            const searchType = getNearestSearchTypeForFilter(filter);
            const entry = nearestSessions.get(searchType);
            const current = entry ? entry.sortedItems.filter(function (it) { return matchesSearchFilter(it.icao, filter); }) : [];
            refreshNearestForType(searchType, wptInput, current.length === 0, function () {
                if (activeSubmenuState.isOpen && activeSubmenuState.tabIndex === 1 && activeSubmenuState.wptInput === wptInput) {
                    const updatedEntry = nearestSessions.get(searchType);
                    const updated = updatedEntry ? updatedEntry.sortedItems.filter(function (it) { return matchesSearchFilter(it.icao, filter); }) : [];
                    const hadNone = activeSubmenuState.items.length === 0;
                    activeSubmenuState.items = updated;
                    if (hadNone && updated.length > 0) {
                        activeSubmenuState.selectedIndex = 0;
                        activeSubmenuState.scrollTop = 0;
                        previewIcaoInWaypointInput(wptInput, updated[0].icao);
                    } else if (activeSubmenuState.selectedIndex >= updated.length) {
                        activeSubmenuState.selectedIndex = updated.length - 1;
                        if (activeSubmenuState.selectedIndex >= 0) {
                            previewIcaoInWaypointInput(wptInput, updated[activeSubmenuState.selectedIndex].icao);
                        }
                    } else if (activeSubmenuState.selectedIndex >= 0 && activeSubmenuState.selectedIndex < updated.length) {
                        previewIcaoInWaypointInput(wptInput, updated[activeSubmenuState.selectedIndex].icao);
                    }
                    renderActiveSubmenuDom();
                    publishSubmenuDiagnostics();
                }
            });
            return current;
        }
        if (tabIndex === 2) {
            loadRecentFromStorage();
            const out = [];
            for (let i = 0; i < recentIcaos.length; i++) {
                const ic = recentIcaos[i];
                if (matchesSearchFilter(ic, filter)) {
                    out.push({ icao: ic, ident: sdk.ICAO.getIdent(ic).trim() });
                }
            }
            return out;
        }
        if (tabIndex === 3) {
            const FST = sdk.FacilitySearchType || {};
            if (filter !== undefined && filter !== FST.All && filter !== FST.AllExceptVisual && filter !== FST.User) {
                return [];
            }
            refreshUserWaypoints(wptInput, function () {
                if (activeSubmenuState.isOpen && activeSubmenuState.tabIndex === 3 && activeSubmenuState.wptInput === wptInput) {
                    const updated = cachedUserItems.filter(function (it) { return matchesSearchFilter(it.icao, filter); });
                    const hadNone = activeSubmenuState.items.length === 0;
                    activeSubmenuState.items = updated;
                    if (hadNone && updated.length > 0) {
                        activeSubmenuState.selectedIndex = 0;
                        activeSubmenuState.scrollTop = 0;
                        previewIcaoInWaypointInput(wptInput, updated[0].icao);
                    } else if (activeSubmenuState.selectedIndex >= updated.length) {
                        activeSubmenuState.selectedIndex = updated.length - 1;
                        if (activeSubmenuState.selectedIndex >= 0) {
                            previewIcaoInWaypointInput(wptInput, updated[activeSubmenuState.selectedIndex].icao);
                        }
                    } else if (activeSubmenuState.selectedIndex >= 0 && activeSubmenuState.selectedIndex < updated.length) {
                        previewIcaoInWaypointInput(wptInput, updated[activeSubmenuState.selectedIndex].icao);
                    }
                    renderActiveSubmenuDom();
                    publishSubmenuDiagnostics();
                }
            });
            return cachedUserItems.filter(function (it) { return matchesSearchFilter(it.icao, filter); });
        }
        return [];
    }

    function ensureSubmenuDom() {
        if (typeof document === 'undefined' || !document.createElement) {
            return null;
        }
        if (document.head && !document.getElementById('wt-g1000-wpt-submenu-styles')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'wt-g1000-wpt-submenu-styles';
            styleEl.textContent = [
                '.wt-wpt-submenu {',
                '  position: absolute;',
                '  z-index: 80;',
                '  width: 162px;',
                '  background: #0a0c0f;',
                '  border: 2px solid #b8c0c8;',
                '  border-radius: 5px;',
                '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.88);',
                '  font-family: Roboto, sans-serif;',
                '  color: whitesmoke;',
                '  pointer-events: none;',
                '  user-select: none;',
                '  box-sizing: border-box;',
                '}',
                '.wt-wpt-submenu-header {',
                '  display: flex;',
                '  align-items: center;',
                '  justify-content: space-between;',
                '  height: 24px;',
                '  padding: 2px 3px;',
                '  background: linear-gradient(to bottom, #2c313a 0%, #14171d 100%);',
                '  border-bottom: 1px solid #6e7680;',
                '  border-radius: 3px 3px 0 0;',
                '  box-sizing: border-box;',
                '}',
                '.wt-wpt-submenu-arrow {',
                '  width: 13px;',
                '  text-align: center;',
                '  color: cyan;',
                '  font-size: 12px;',
                '  line-height: 1;',
                '}',
                '.wt-wpt-submenu-tabbox {',
                '  flex: 1;',
                '  text-align: center;',
                '  color: cyan;',
                '  font-size: 15px;',
                '  line-height: 17px;',
                '  background: #000000;',
                '  border: 1px solid #8c949c;',
                '  padding: 0 3px;',
                '  white-space: nowrap;',
                '  overflow: hidden;',
                '}',
                '.wt-wpt-submenu-body {',
                '  display: flex;',
                '  flex-direction: row;',
                '  height: 140px;',
                '  padding: 2px 3px;',
                '  background: #050608;',
                '  border-radius: 0 0 3px 3px;',
                '  box-sizing: border-box;',
                '}',
                '.wt-wpt-submenu-list {',
                '  flex: 1;',
                '  display: flex;',
                '  flex-direction: column;',
                '  overflow: hidden;',
                '}',
                '.wt-wpt-submenu-row {',
                '  height: 19.4px;',
                '  line-height: 19.4px;',
                '  padding: 0 5px;',
                '  font-size: 16px;',
                '  color: whitesmoke;',
                '  white-space: nowrap;',
                '  overflow: hidden;',
                '}',
                '.wt-wpt-submenu-row.wt-selected {',
                '  background-color: cyan;',
                '  color: #000000;',
                '  font-weight: bold;',
                '}',
                '.wt-wpt-submenu-scrollbar {',
                '  width: 6px;',
                '  margin-left: 3px;',
                '  background: #1b1f26;',
                '  border-left: 1px solid #3a4048;',
                '  position: relative;',
                '}',
                '.wt-wpt-submenu-thumb {',
                '  position: absolute;',
                '  left: 1px;',
                '  right: 1px;',
                '  background: #d8dee6;',
                '  border-radius: 1px;',
                '}'
            ].join('\n');
            document.head.appendChild(styleEl);
        }

        if (!activeSubmenuState.domRoot) {
            const root = document.createElement('div');
            root.className = 'wt-wpt-submenu';
            root.style.display = 'none';

            const header = document.createElement('div');
            header.className = 'wt-wpt-submenu-header';

            const leftArrow = document.createElement('span');
            leftArrow.className = 'wt-wpt-submenu-arrow';
            leftArrow.textContent = '\u25C4';

            const tabBox = document.createElement('div');
            tabBox.className = 'wt-wpt-submenu-tabbox';

            const rightArrow = document.createElement('span');
            rightArrow.className = 'wt-wpt-submenu-arrow';
            rightArrow.textContent = '\u25BA';

            header.appendChild(leftArrow);
            header.appendChild(tabBox);
            header.appendChild(rightArrow);

            const body = document.createElement('div');
            body.className = 'wt-wpt-submenu-body';

            const list = document.createElement('div');
            list.className = 'wt-wpt-submenu-list';

            const scrollbar = document.createElement('div');
            scrollbar.className = 'wt-wpt-submenu-scrollbar';
            const thumb = document.createElement('div');
            thumb.className = 'wt-wpt-submenu-thumb';
            scrollbar.appendChild(thumb);

            body.appendChild(list);
            body.appendChild(scrollbar);

            root.appendChild(header);
            root.appendChild(body);

            activeSubmenuState.domRoot = root;
            activeSubmenuState.domLeftArrow = leftArrow;
            activeSubmenuState.domRightArrow = rightArrow;
            activeSubmenuState.domTabBox = tabBox;
            activeSubmenuState.domList = list;
            activeSubmenuState.domScrollbar = scrollbar;
            activeSubmenuState.domThumb = thumb;
        }
        return activeSubmenuState.domRoot;
    }

    function positionSubmenuDom(inputComp) {
        const root = ensureSubmenuDom();
        if (!root || !inputComp) {
            return;
        }
        try {
            const inputEl = (typeof inputComp.getHighlightElement === 'function' && inputComp.getHighlightElement())
                || (inputComp.inputValueContainerRef && inputComp.inputValueContainerRef.instance)
                || null;
            if (!inputEl || typeof inputEl.getBoundingClientRect !== 'function') {
                if (document.body && root.parentElement !== document.body) {
                    document.body.appendChild(root);
                }
                return;
            }
            const hostEl = (typeof inputEl.closest === 'function' && inputEl.closest('.popout-dialog, .mfd-dark-background'))
                || document.body;
            if (hostEl && root.parentElement !== hostEl) {
                hostEl.appendChild(root);
            }
            const elRect = inputEl.getBoundingClientRect();
            const hostRect = hostEl.getBoundingClientRect();
            let left = Math.round(elRect.left - hostRect.left);
            let top = Math.round(elRect.bottom - hostRect.top + 2);

            if (hostRect.width > 170 && (left + 162) > (hostRect.width - 4)) {
                left = Math.max(4, Math.round(hostRect.width - 166));
            }
            if (left < 2) {
                left = 2;
            }
            if (typeof window !== 'undefined' && window.innerHeight > 220 && (elRect.bottom + 168) > (window.innerHeight - 36)) {
                top -= Math.round((elRect.bottom + 168) - (window.innerHeight - 36));
            }
            root.style.left = left + 'px';
            root.style.top = top + 'px';
        } catch (e) {}
    }

    function renderActiveSubmenuDom() {
        const root = ensureSubmenuDom();
        if (!root) {
            return;
        }
        if (!activeSubmenuState.isOpen) {
            root.style.display = 'none';
            return;
        }
        root.style.display = 'block';
        activeSubmenuState.domTabBox.textContent = SUBMENU_TABS[activeSubmenuState.tabIndex] || '';
        activeSubmenuState.domLeftArrow.style.visibility = activeSubmenuState.tabIndex > 0 ? 'visible' : 'hidden';
        activeSubmenuState.domRightArrow.style.visibility = activeSubmenuState.tabIndex < (SUBMENU_TABS.length - 1) ? 'visible' : 'hidden';

        const listEl = activeSubmenuState.domList;
        while (listEl.firstChild) {
            listEl.removeChild(listEl.firstChild);
        }

        const items = activeSubmenuState.items;
        const start = activeSubmenuState.scrollTop;
        const end = Math.min(items.length, start + SUBMENU_VISIBLE_ROWS);
        for (let i = start; i < end; i++) {
            const row = document.createElement('div');
            row.className = 'wt-wpt-submenu-row' + (i === activeSubmenuState.selectedIndex ? ' wt-selected' : '');
            row.textContent = items[i].ident;
            listEl.appendChild(row);
        }

        if (items.length > SUBMENU_VISIBLE_ROWS) {
            activeSubmenuState.domScrollbar.style.display = 'block';
            const trackH = 136;
            const thumbH = Math.max(16, Math.round((SUBMENU_VISIBLE_ROWS / items.length) * trackH));
            const maxScroll = Math.max(1, items.length - SUBMENU_VISIBLE_ROWS);
            const thumbTop = Math.round((activeSubmenuState.scrollTop / maxScroll) * (trackH - thumbH));
            activeSubmenuState.domThumb.style.height = thumbH + 'px';
            activeSubmenuState.domThumb.style.top = thumbTop + 'px';
        } else {
            activeSubmenuState.domScrollbar.style.display = 'none';
        }
        try {
            if (typeof root.getBoundingClientRect === 'function') {
                const r = root.getBoundingClientRect();
                const ok = (r.width >= 150 && r.height >= 120 && r.left >= 0 && r.top >= 20 && r.right <= 1025 && r.bottom <= 740) ? 1 : 0;
                safeSetSimVar(isMfdContext ? 'L:CT182T_DBG_MFD_SUB_RECT_OK' : 'L:CT182T_DBG_PFD_SUB_RECT_OK', 'Number', ok);
            }
        } catch (e) {}
    }

    function previewIcaoInWaypointInput(wptInput, icao) {
        if (!wptInput || !wptInput.store) {
            return Promise.resolve();
        }
        const ident = (icao && sdk.ICAO && typeof sdk.ICAO.getIdent === 'function')
            ? sdk.ICAO.getIdent(icao).trim()
            : '';
        try {
            if (wptInput.props && wptInput.props.selectedIcao && typeof wptInput.props.selectedIcao.set === 'function') {
                wptInput.props.selectedIcao.set(icao || '');
            }
            if (typeof wptInput.onInputTextValueOverride === 'function') {
                wptInput.onInputTextValueOverride(ident);
            }
            if (wptInput.store.inputValue && typeof wptInput.store.inputValue.set === 'function') {
                wptInput.store.inputValue.set(ident);
            }
            if (!icao) {
                wptInput.store._matchedIcaos = [];
                wptInput.store._matchedWaypoints = [];
                if (typeof wptInput.store.clearWaypoint === 'function') {
                    wptInput.store.clearWaypoint();
                }
                wptInput._wtPendingLoadPromise = Promise.resolve();
                return wptInput._wtPendingLoadPromise;
            }
            const curWpt = wptInput.store.selectedWaypoint && wptInput.store.selectedWaypoint.get();
            if (curWpt && curWpt.facility && curWpt.facility.get() && curWpt.facility.get().icao === icao) {
                wptInput._wtPendingLoadPromise = Promise.resolve();
                return wptInput._wtPendingLoadPromise;
            }
            if (typeof wptInput.store.loadIcaoData === 'function') {
                wptInput._wtPendingLoadPromise = Promise.resolve(wptInput.store.loadIcaoData([icao])).catch(function () {});
                return wptInput._wtPendingLoadPromise;
            }
        } catch (e) {}
        wptInput._wtPendingLoadPromise = Promise.resolve();
        return wptInput._wtPendingLoadPromise;
    }

    function hideSubmenuInternal() {
        const prevInput = activeSubmenuState.inputComp;
        activeSubmenuState.isOpen = false;
        activeSubmenuState.inputComp = null;
        activeSubmenuState.wptInput = null;
        activeSubmenuState.items = [];
        activeSubmenuState.selectedIndex = -1;
        activeSubmenuState.scrollTop = 0;
        if (prevInput) {
            prevInput._wtSubmenuOpen = false;
        }
        renderActiveSubmenuDom();
        publishSubmenuDiagnostics();
    }

    function openSubmenuForInput(inputComp, mod) {
        const wptInput = inputComp && (inputComp._wtParentWaypointInput || (inputComp.props && inputComp.props._wtParentWaypointInput));
        if (!inputComp || !wptInput) {
            return false;
        }
        if (activeSubmenuState.isOpen && activeSubmenuState.inputComp && activeSubmenuState.inputComp !== inputComp) {
            cancelSubmenuForInput(activeSubmenuState.inputComp);
        }

        const savedIcao = (wptInput.props && wptInput.props.selectedIcao && typeof wptInput.props.selectedIcao.get === 'function')
            ? (wptInput.props.selectedIcao.get() || '')
            : '';
        const savedRawText = typeof inputComp.getRawText === 'function' ? (inputComp.getRawText() || '') : '';

        inputComp._wtParentWaypointInput = wptInput;
        inputComp._wtSubmenuOpen = true;
        if (!inputComp.getIsActivated()) {
            inputComp.activate();
        }

        activeSubmenuState.isOpen = true;
        activeSubmenuState.inputComp = inputComp;
        activeSubmenuState.wptInput = wptInput;
        activeSubmenuState.mod = mod;
        activeSubmenuState.savedIcao = savedIcao;
        activeSubmenuState.savedRawText = savedRawText;
        activeSubmenuState.tabIndex = 0;

        // Pre-warm Nearest in background right as submenu opens so switching to Tab 1 is instant
        const filter = wptInput.props ? wptInput.props.filter : undefined;
        refreshNearestForType(getNearestSearchTypeForFilter(filter), wptInput, false, null);

        const initialItems = getTabItems(0, wptInput);
        activeSubmenuState.items = initialItems;
        activeSubmenuState.scrollTop = 0;
        if (initialItems.length > 0) {
            activeSubmenuState.selectedIndex = 0;
            previewIcaoInWaypointInput(wptInput, initialItems[0].icao);
        } else {
            activeSubmenuState.selectedIndex = -1;
        }

        positionSubmenuDom(inputComp);
        renderActiveSubmenuDom();
        publishSubmenuDiagnostics();
        return true;
    }

    function moveSubmenuTab(delta) {
        if (!activeSubmenuState.isOpen || !activeSubmenuState.wptInput) {
            return false;
        }
        const nextTab = activeSubmenuState.tabIndex + delta;
        if (nextTab < 0 || nextTab >= SUBMENU_TABS.length) {
            return true;
        }
        activeSubmenuState.tabIndex = nextTab;
        const items = getTabItems(nextTab, activeSubmenuState.wptInput);
        activeSubmenuState.items = items;
        activeSubmenuState.scrollTop = 0;
        if (items.length > 0) {
            activeSubmenuState.selectedIndex = 0;
            previewIcaoInWaypointInput(activeSubmenuState.wptInput, items[0].icao);
        } else {
            activeSubmenuState.selectedIndex = -1;
        }
        renderActiveSubmenuDom();
        publishSubmenuDiagnostics();
        return true;
    }

    function moveSubmenuSelection(delta) {
        if (!activeSubmenuState.isOpen || !activeSubmenuState.wptInput) {
            return false;
        }
        const items = activeSubmenuState.items;
        if (!items || items.length === 0) {
            return true;
        }
        let nextIdx = activeSubmenuState.selectedIndex + delta;
        if (nextIdx < 0) {
            nextIdx = 0;
        } else if (nextIdx >= items.length) {
            nextIdx = items.length - 1;
        }
        if (nextIdx === activeSubmenuState.selectedIndex) {
            return true;
        }
        activeSubmenuState.selectedIndex = nextIdx;
        if (nextIdx < activeSubmenuState.scrollTop) {
            activeSubmenuState.scrollTop = nextIdx;
        } else if (nextIdx >= activeSubmenuState.scrollTop + SUBMENU_VISIBLE_ROWS) {
            activeSubmenuState.scrollTop = nextIdx - SUBMENU_VISIBLE_ROWS + 1;
        }
        previewIcaoInWaypointInput(activeSubmenuState.wptInput, items[nextIdx].icao);
        renderActiveSubmenuDom();
        publishSubmenuDiagnostics();
        return true;
    }

    function cancelSubmenuForInput(inputComp) {
        if (!activeSubmenuState.isOpen) {
            if (inputComp) {
                inputComp._wtSubmenuOpen = false;
            }
            return true;
        }
        const wptInput = activeSubmenuState.wptInput;
        const savedIcao = activeSubmenuState.savedIcao;
        const savedRawText = activeSubmenuState.savedRawText;

        hideSubmenuInternal();

        if (wptInput) {
            if (savedIcao) {
                previewIcaoInWaypointInput(wptInput, savedIcao);
            } else {
                previewIcaoInWaypointInput(wptInput, '');
                if (savedRawText && inputComp && typeof inputComp.setText === 'function') {
                    inputComp.setText(savedRawText, 0, false);
                }
            }
        }
        if (inputComp && inputComp.getIsActivated()) {
            inputComp.deactivate();
        }
        return true;
    }

    function acceptSubmenuSelection(inputComp) {
        if (!activeSubmenuState.isOpen) {
            return false;
        }
        const wptInput = activeSubmenuState.wptInput;
        const chosen = (activeSubmenuState.selectedIndex >= 0 && activeSubmenuState.selectedIndex < activeSubmenuState.items.length)
            ? activeSubmenuState.items[activeSubmenuState.selectedIndex]
            : null;

        if (!chosen || !wptInput) {
            return cancelSubmenuForInput(inputComp);
        }

        recordRecentIcao(chosen.icao);
        const loadPromise = previewIcaoInWaypointInput(wptInput, chosen.icao);

        hideSubmenuInternal();
        if (inputComp && inputComp.getIsActivated()) {
            inputComp.deactivate();
        }

        // In Waypoint Information Window (FPL), 1st ENT accepts identifier from submenu
        // into WptInfo ("Press ENT to accept"), and 2nd ENT accepts WptInfo into FPL.
        // In SelectApproach / SelectDepArr / DirectTo / WPT pages, ENT accepts and advances immediately.
        if (!wptInput._wtIsInsideWptInfo && typeof wptInput.onInputEnterPressed === 'function') {
            const curWpt = wptInput.store && wptInput.store.selectedWaypoint && wptInput.store.selectedWaypoint.get();
            if (curWpt && curWpt.facility && curWpt.facility.get() && curWpt.facility.get().icao === chosen.icao) {
                wptInput.onInputEnterPressed();
            } else {
                loadPromise.then(function () {
                    wptInput.onInputEnterPressed();
                });
            }
        }
        return true;
    }

    function registerSubmenuFms(fms) {
        if (!fms || submenuFms === fms) {
            return;
        }
        submenuFms = fms;
        if (fms.facLoader && !sharedFacLoader) {
            sharedFacLoader = fms.facLoader;
        }
        seedRecentFromFlightPlan(fms);
        publishFlightPlanDiagnostics();
        try {
            if (fms.flightPlanner && typeof fms.flightPlanner.onEvent === 'function') {
                fms.flightPlanner.onEvent('fplOriginDestChanged').handle(function (evt) {
                    if (evt && evt.airport) {
                        recordRecentIcao(evt.airport);
                    }
                    publishFlightPlanDiagnostics();
                });
                fms.flightPlanner.onEvent('fplLegChange').handle(function (evt) {
                    const LET = sdk.LegEventType || {};
                    if (evt && (LET.Added === undefined || evt.type === LET.Added) && evt.leg && evt.leg.leg && evt.leg.leg.fixIcao) {
                        recordRecentIcao(evt.leg.leg.fixIcao);
                    }
                    publishFlightPlanDiagnostics();
                });
                fms.flightPlanner.onEvent('fplUserDataSet').handle(publishFlightPlanDiagnostics);
                fms.flightPlanner.onEvent('fplSegmentChange').handle(publishFlightPlanDiagnostics);
            }
        } catch (e) {}
    }

    function patchWaypointSubmenuUi() {
        try {
            const mods = [window.g1000nxipfd, window.g1000nximfd];
            for (let m = 0; m < mods.length; m++) {
                const mod = mods[m];
                if (!mod) {
                    continue;
                }

                // 1. Tag WptInfo's WaypointInput & auto-open submenu when opened via FPL UPPER_DEC
                const WptInfoCls = mod.WptInfo;
                if (WptInfoCls && WptInfoCls.prototype && !WptInfoCls.prototype._wtWptSubmenuPatched) {
                    WptInfoCls.prototype._wtWptSubmenuPatched = true;

                    if (typeof WptInfoCls.prototype.renderWaypointInput === 'function') {
                        const origRenderWptInput = WptInfoCls.prototype.renderWaypointInput;
                        WptInfoCls.prototype.renderWaypointInput = function () {
                            const vnode = origRenderWptInput.apply(this, arguments);
                            if (vnode && vnode.props) {
                                vnode.props._wtOwnerWptInfo = this;
                            }
                            return vnode;
                        };
                    }

                    if (typeof WptInfoCls.prototype.onViewOpened === 'function') {
                        const origOnViewOpened = WptInfoCls.prototype.onViewOpened;
                        WptInfoCls.prototype.onViewOpened = function () {
                            const res = origOnViewOpened.apply(this, arguments);
                            if (Date.now() < autoOpenSubmenuUntil) {
                                autoOpenSubmenuUntil = 0;
                                const self = this;
                                setTimeout(function () {
                                    try {
                                        const wptInput = self._wtWaypointInputInstance;
                                        const inputComp = wptInput && wptInput.inputComponentRef && wptInput.inputComponentRef.instance;
                                        if (inputComp && inputComp.getIsFocused() && !inputComp._wtSubmenuOpen) {
                                            openSubmenuForInput(inputComp, mod);
                                        }
                                    } catch (e) {}
                                }, 0);
                            }
                            return res;
                        };
                    }

                    if (typeof WptInfoCls.prototype.onViewClosed === 'function') {
                        const origOnViewClosed = WptInfoCls.prototype.onViewClosed;
                        WptInfoCls.prototype.onViewClosed = function () {
                            if (activeSubmenuState.isOpen && activeSubmenuState.wptInput === this._wtWaypointInputInstance) {
                                hideSubmenuInternal();
                            }
                            return origOnViewClosed.apply(this, arguments);
                        };
                    }
                }

                // 2. Link WaypointInput -> child InputComponent & record manual Recent entries
                const WptInputCls = mod.WaypointInput;
                if (WptInputCls && WptInputCls.prototype && !WptInputCls.prototype._wtWptSubmenuPatched) {
                    WptInputCls.prototype._wtWptSubmenuPatched = true;

                    if (typeof WptInputCls.prototype.render === 'function') {
                        const origRender = WptInputCls.prototype.render;
                        WptInputCls.prototype.render = function () {
                            const vnode = origRender.apply(this, arguments);
                            try {
                                if (this.props && this.props._wtOwnerWptInfo) {
                                    this._wtIsInsideWptInfo = true;
                                    this.props._wtOwnerWptInfo._wtWaypointInputInstance = this;
                                }
                                if (vnode && Array.isArray(vnode.children) && vnode.children[0] && vnode.children[0].props) {
                                    vnode.children[0].props._wtParentWaypointInput = this;
                                }
                            } catch (e) {}
                            return vnode;
                        };
                    }

                    const origOnAfterRender = WptInputCls.prototype.onAfterRender;
                    WptInputCls.prototype.onAfterRender = function () {
                        if (typeof origOnAfterRender === 'function') {
                            origOnAfterRender.apply(this, arguments);
                        }
                        try {
                            if (this.props && this.props._wtOwnerWptInfo) {
                                this._wtIsInsideWptInfo = true;
                                this.props._wtOwnerWptInfo._wtWaypointInputInstance = this;
                            }
                            if (this.inputComponentRef && this.inputComponentRef.instance) {
                                this.inputComponentRef.instance._wtParentWaypointInput = this;
                            }
                        } catch (e) {}
                    };

                    if (typeof WptInputCls.prototype.onInputEnterPressed === 'function') {
                        const origEnterPressed = WptInputCls.prototype.onInputEnterPressed;
                        WptInputCls.prototype.onInputEnterPressed = function () {
                            try {
                                const fw = this.store && this.store.selectedWaypoint && this.store.selectedWaypoint.get();
                                const fac = fw && fw.facility && fw.facility.get();
                                if (fac && fac.icao) {
                                    recordRecentIcao(fac.icao);
                                }
                            } catch (e) {}
                            return origEnterPressed.apply(this, arguments);
                        };
                    }
                }

                // 3. Patch InputComponent for counter-clockwise submenu activation & controls
                const InputCls = mod.InputComponent;
                if (InputCls && InputCls.prototype && !InputCls.prototype._wtWptSubmenuPatched) {
                    InputCls.prototype._wtWptSubmenuPatched = true;

                    const origOnAfterRender = InputCls.prototype.onAfterRender;
                    InputCls.prototype.onAfterRender = function () {
                        const res = origOnAfterRender.apply(this, arguments);
                        if (this.props && this.props._wtParentWaypointInput) {
                            this._wtParentWaypointInput = this.props._wtParentWaypointInput;
                        }
                        return res;
                    };

                    const origOnActivated = InputCls.prototype.onActivated;
                    InputCls.prototype.onActivated = function () {
                        if (this._wtSubmenuOpen) {
                            this.previousValue = typeof this.getText === 'function' ? this.getText() : '';
                            const focusClass = (mod.UiControl && mod.UiControl.FOCUS_CLASS) ? mod.UiControl.FOCUS_CLASS : 'highlight-select';
                            if (this.selectedSpanRef && this.selectedSpanRef.instance && this.selectedSpanRef.instance.classList) {
                                this.selectedSpanRef.instance.classList.remove(focusClass);
                            }
                            const hl = typeof this.getHighlightElement === 'function' ? this.getHighlightElement() : null;
                            if (hl && hl.classList) {
                                hl.classList.add(focusClass);
                            }
                            return;
                        }
                        return origOnActivated.apply(this, arguments);
                    };

                    const origOnDeactivated = InputCls.prototype.onDeactivated;
                    InputCls.prototype.onDeactivated = function () {
                        if (this._wtSubmenuOpen || (activeSubmenuState.isOpen && activeSubmenuState.inputComp === this)) {
                            hideSubmenuInternal();
                        }
                        return origOnDeactivated.apply(this, arguments);
                    };

                    const origUpperDec = InputCls.prototype.onUpperKnobDec;
                    InputCls.prototype.onUpperKnobDec = function () {
                        const wptParent = this._wtParentWaypointInput || (this.props && this.props._wtParentWaypointInput);
                        if (this._wtSubmenuOpen) {
                            return moveSubmenuTab(-1);
                        }
                        if (wptParent && !this.getIsActivated()) {
                            this._wtParentWaypointInput = wptParent;
                            return openSubmenuForInput(this, mod);
                        }
                        return origUpperDec.apply(this, arguments);
                    };

                    const origUpperInc = InputCls.prototype.onUpperKnobInc;
                    InputCls.prototype.onUpperKnobInc = function () {
                        if (this._wtSubmenuOpen) {
                            return moveSubmenuTab(1);
                        }
                        return origUpperInc.apply(this, arguments);
                    };

                    const origLowerInc = InputCls.prototype.onLowerKnobInc;
                    InputCls.prototype.onLowerKnobInc = function () {
                        if (this._wtSubmenuOpen) {
                            return moveSubmenuSelection(1);
                        }
                        return origLowerInc.apply(this, arguments);
                    };

                    const origLowerDec = InputCls.prototype.onLowerKnobDec;
                    InputCls.prototype.onLowerKnobDec = function () {
                        if (this._wtSubmenuOpen) {
                            return moveSubmenuSelection(-1);
                        }
                        return origLowerDec.apply(this, arguments);
                    };

                    const origEnter = InputCls.prototype.onEnter;
                    InputCls.prototype.onEnter = function () {
                        if (this._wtSubmenuOpen) {
                            return acceptSubmenuSelection(this);
                        }
                        return origEnter.apply(this, arguments);
                    };

                    const origClr = InputCls.prototype.onClr;
                    InputCls.prototype.onClr = function () {
                        if (this._wtSubmenuOpen) {
                            return cancelSubmenuForInput(this);
                        }
                        return origClr.apply(this, arguments);
                    };

                    const origInteraction = InputCls.prototype.onInteractionEvent;
                    InputCls.prototype.onInteractionEvent = function (evt) {
                        if (this._wtSubmenuOpen && mod.FmsHEvent && evt === mod.FmsHEvent.UPPER_PUSH) {
                            return cancelSubmenuForInput(this);
                        }
                        return origInteraction.apply(this, arguments);
                    };
                }

                // 4. Patch G1000UiControl so counter-clockwise small knob on FPL rows opens WptInfo + Submenu
                const G1000Ctrl = mod.G1000UiControl;
                if (G1000Ctrl && G1000Ctrl.prototype && !G1000Ctrl.prototype._wtWptSubmenuPatched) {
                    G1000Ctrl.prototype._wtWptSubmenuPatched = true;

                    const origCtrlUpperDec = G1000Ctrl.prototype.onUpperKnobDec;
                    G1000Ctrl.prototype.onUpperKnobDec = function (source) {
                        if (this.props && this.props.fms) {
                            registerSubmenuFms(this.props.fms);
                        }
                        if (this.props && this.props.onUpperKnobDec) {
                            return origCtrlUpperDec.call(this, source);
                        }
                        const isFplRow = !!(mod.FPLEmptyRow && (this instanceof mod.FPLEmptyRow))
                            || !!(this.fixEl && this.highlightElementRef && this.props && typeof this.props.onUpperKnobInc === 'function');
                        if (isFplRow && this.props && typeof this.props.onUpperKnobInc === 'function') {
                            autoOpenSubmenuUntil = Date.now() + 800;
                            const handled = this.props.onUpperKnobInc(source);
                            if (!handled) {
                                autoOpenSubmenuUntil = 0;
                            }
                            return handled;
                        }
                        return origCtrlUpperDec.call(this, source);
                    };
                }

                // 5. Fallback capture of FMS from SelectApproachController / SelectDepArrController
                const depArrCtrls = [mod.SelectApproachController, mod.SelectDepArrController];
                for (let c = 0; c < depArrCtrls.length; c++) {
                    const C = depArrCtrls[c];
                    if (C && C.prototype && !C.prototype._wtFmsCapturePatched && typeof C.prototype.initialize === 'function') {
                        C.prototype._wtFmsCapturePatched = true;
                        const origInit = C.prototype.initialize;
                        C.prototype.initialize = function () {
                            if (this.fms) {
                                registerSubmenuFms(this.fms);
                            }
                            return origInit.apply(this, arguments);
                        };
                    }
                }
            }
        } catch (e) {
            console.error('CT182TGfc700Plugin: patchWaypointSubmenuUi error', e);
        }
    }

    function wireSubmenuViewService(vs) {
        if (!vs || submenuViewService === vs) {
            return;
        }
        submenuViewService = vs;
        try {
            if (vs.activeViewKey && typeof vs.activeViewKey.sub === 'function') {
                const viewVar = isMfdContext ? 'L:CT182T_MFD_VIEW_CODE' : 'L:CT182T_PFD_VIEW_CODE';
                vs.activeViewKey.sub(function (key) {
                    if (activeSubmenuState.isOpen && activeSubmenuState.inputComp && !activeSubmenuState.inputComp.getIsFocused()) {
                        hideSubmenuInternal();
                    }
                    const k = String(key || '');
                    let code = 0;
                    if (k === '' || k === 'NavMapPage') code = 0;
                    else if (k === 'FPLCatalogPage') code = 10;
                    else if (k === 'UserWptInfoPage') code = 11;
                    else if (k === 'NearestUserWptsPage') code = 12;
                    else if (k === 'NearestFreqsPage') code = 13;
                    else if (k === 'GPSStatusPage') code = 16;
                    else if (k === 'SystemStatusPage') code = 17;
                    else if (k.indexOf('HoldAt') >= 0) code = 8;
                    else if (k.indexOf('AirportInformation') >= 0) code = 9;
                    else if (k.indexOf('PageMenuDialog') >= 0) code = 14;
                    else if (k.indexOf('MessageDialog') >= 0) code = 15;
                    else if (k.indexOf('FPL') >= 0) code = 1;
                    else if (k === 'PROC') code = 2;
                    else if (k.indexOf('SelectApproach') >= 0 || k === 'SelectProcedurePage') code = 3;
                    else if (k.indexOf('WptInfo') >= 0) code = 4;
                    else if (k.indexOf('DirectTo') >= 0) code = 5;
                    else if (k.indexOf('SetRunway') >= 0) code = 6;
                    else code = 7;
                    safeSetSimVar(viewVar, 'Number', code);
                }, true);
            }
        } catch (e) {}
    }

    let dbgBridgeStarted = false;
    function installWaypointSubmenuSupport(binder) {
        if (shouldInstallG1000Enhancements) {
        patchWaypointSubmenuUi();
    }
        loadRecentFromStorage();
        publishSubmenuDiagnostics();
        safeSetSimVar('L:CT182T_WPT_SUB_READY', 'Number', 1);

        if (!binder) {
            return;
        }
        if (binder.fms) {
            registerSubmenuFms(binder.fms);
        }
        if (binder.viewService) {
            wireSubmenuViewService(binder.viewService);
        }
        if (binder.bus && !submenuBus) {
            submenuBus = binder.bus;
            try {
                const sub = submenuBus.getSubscriber();
                sub.on('gps-position').atFrequency(0.2).handle(function (pos) {
                    if (pos && typeof pos.lat === 'number' && typeof pos.long === 'number' && !(pos.lat === 0 && pos.long === 0)) {
                        planeLat = pos.lat;
                        planeLon = pos.long;
                    }
                });
            } catch (e) {}

            // Pre-warm Nearest Airports session shortly after boot so Nearest tab is populated immediately
            if (typeof setTimeout === 'function') {
                setTimeout(function () {
                    const FST = sdk.FacilitySearchType || {};
                    refreshNearestForType(FST.Airport !== undefined ? FST.Airport : 1, null, true, null);
                }, 1500);
            }
        }

        // Lightweight SimConnect H-Event bridge for automated PFD/MFD verification
        if (binder.bus && !dbgBridgeStarted && typeof setInterval === 'function' && typeof SimVar !== 'undefined') {
            dbgBridgeStarted = true;
            const cmdVar = isMfdContext ? 'L:CT182T_DBG_MFD_HEVT' : 'L:CT182T_DBG_PFD_HEVT';
            const pfx = isMfdContext ? 'AS1000_MFD_' : 'AS1000_PFD_';
            const evtSuffixes = {
                1: 'FPL_Push',
                2: 'PROC_Push',
                3: 'DIRECTTO',
                4: 'MENU_Push',
                5: 'FMS_Upper_PUSH',
                6: 'FMS_Upper_INC',
                7: 'FMS_Upper_DEC',
                8: 'FMS_Lower_INC',
                9: 'FMS_Lower_DEC',
                10: 'ENT_Push',
                11: 'CLR',
                12: 'SOFTKEYS_10', // ACT Leg (index 9)
                13: 'SOFTKEYS_9',  // ATK OFS / STAR (index 8)
                14: 'SOFTKEYS_8',  // APR / VNV D-> (index 7)
                15: 'SOFTKEYS_5',  // APT / View (index 4)
                16: 'COM_Switch_Long', // 121.500 MHz emergency COM hold
                17: 'JOYSTICK_PUSH',
                18: 'JOYSTICK_UP',
                19: 'JOYSTICK_RIGHT',
                20: 'SOFTKEYS_4',  // New WPT / GPS2 / ARFRM (index 3)
                21: 'SOFTKEYS_6',  // Narrow / RAIM (index 5)
                22: 'SOFTKEYS_11', // Back (index 10)
                23: 'SOFTKEYS_3',  // GPS1 / LRU (index 2)
                24: 'SOFTKEYS_7'   // SBAS (index 6)
            };
            if (isMfdContext) {
                const rstVars = [
                    'L:CT182T_DBG_ACT_LEG_EN', 'L:CT182T_DBG_WIDE_FPL', 'L:CT182T_DBG_CUM_FPL',
                    'L:CT182T_DBG_WIDE_PLAN_TOP', 'L:CT182T_DBG_WIDE_PLAN_W', 'L:CT182T_DBG_WIDE_MAP_TOP',
                    'L:CT182T_DBG_WIDE_MAP_H', 'L:CT182T_DBG_WIDE_VNV_LEFT', 'L:CT182T_DBG_WIDE_COLS_OK',
                    'L:CT182T_DBG_MODAL_OPEN', 'L:CT182T_DBG_MODAL_RECT_OK', 'L:CT182T_DBG_CITY_MATCHES',
                    'L:CT182T_DBG_CUSTPAGE_OK', 'L:CT182T_DBG_NRST_FREQ_CNT', 'L:CT182T_DBG_TUNED_HZ',
                    'L:CT182T_DBG_MAP_PTR_ACTIVE', 'L:CT182T_DBG_AUXPAGE_OK', 'L:CT182T_GPS_SELECTED_RX',
                    'L:CT182T_GPS_SAT_COUNT', 'L:CT182T_GPS_WAAS_ACTIVE', 'L:CT182T_GPS_RAIM_STATE',
                    'L:CT182T_SYS_LRU_OK_COUNT', 'L:CT182T_SYS_LRU_TOTAL'
                ];
                for (let r = 0; r < rstVars.length; r++) {
                    safeSetSimVar(rstVars[r], 'Number', 0);
                }
                safeSetSimVar('L:CT182T_DBG_MFD_SPLASH', 'Number', 2);
            }
            setInterval(function () {
                try {
                    if (isMfdContext && typeof document !== 'undefined') {
                        const cfm = document.querySelector('.startup-confirm-screen');
                        const wrap = cfm && cfm.parentElement;
                        let splash = 0;
                        if (wrap && wrap.classList && !wrap.classList.contains('hidden')) {
                            splash = (cfm.classList && cfm.classList.contains('hidden')) ? 2 : 1;
                        }
                        SimVar.SetSimVarValue('L:CT182T_DBG_MFD_SPLASH', 'Number', splash);
                    }
                    const cmd = Math.round(Number(SimVar.GetSimVarValue(cmdVar, 'Number') || 0));
                    if (cmd > 0) {
                        SimVar.SetSimVarValue(cmdVar, 'Number', 0);
                        const suffix = evtSuffixes[cmd];
                        if (suffix && binder.bus) {
                            binder.bus.getPublisher().pub('hEvent', pfx + suffix, false, false);
                        }
                    }
                } catch (e) {}
            }, 60);
        }
    }

    if (shouldInstallG1000Enhancements) {
        patchWaypointSubmenuUi();
    }

    // =========================================================================
    // 1C. WTG1000 NXi Usability Fixes — Batch 1 (Easy & Easy-Medium Items):
    //     - Item #1: Enable 'ACT Leg' softkey on MFD FPL page
    //     - Item #2: FPL Section Headers (Origin, Enroute, Destination,
    //                Departure, Arrival, Approach) FMS knob, ENT & CLR actions
    //     - Item #3: WPT Information pages Direct-To pre-fill, MENU, and
    //                APT / RNWY / FREQ / APR / DP / STAR softkeys
    //     - Item #7: Hold At Present Position (PPOS) & 1st-leg Hold At Waypoint
    //     - Item #18: 121.50 MHz Emergency COM Hold & BARO/Arrival Advisories
    // =========================================================================

    let pluginMenuSystem = null;
    let mfdFplSelectedElement = null;
    let lastMfdFplSelectedLeg = null;
    let focusedFplFixCtrl = null;
    let lastFocusedFplFixCtrl = null;
    let currentAirportInfoPage = null;
    let lastComLongSwapMs = 0;

    let baroAlertEnabled = true;
    let arrivalAlertEnabled = true;
    let baroClimbAlertActive = false;
    let baroDescAlertActive = false;
    let wasAboveTransAlt = false;
    let arrivalAlertActiveForDest = '';

    function resolveLegIndexesInPrimaryPlan(legDef) {
        if (!legDef || !submenuFms || typeof submenuFms.hasPrimaryFlightPlan !== 'function' || !submenuFms.hasPrimaryFlightPlan()) {
            return null;
        }
        try {
            const plan = submenuFms.getPrimaryFlightPlan();
            const globalIdx = plan.getLegIndexFromLeg(legDef);
            if (globalIdx < 0) {
                return null;
            }
            const segIdx = plan.getSegmentIndex(globalIdx);
            const seg = plan.tryGetSegment(segIdx);
            if (!seg) {
                return null;
            }
            const segLegIdx = seg.legs.indexOf(legDef);
            if (segLegIdx < 0) {
                return null;
            }
            return { plan: plan, globalIndex: globalIdx, segmentIndex: segIdx, segmentLegIndex: segLegIdx };
        } catch (e) {
            return null;
        }
    }

    function updateMfdFplSoftkeys() {
        if (!isMfdContext || !pluginMenuSystem) {
            return;
        }
        try {
            const fplnMenu = typeof pluginMenuSystem.getMenu === 'function'
                ? pluginMenuSystem.getMenu('fpln-menu')
                : (pluginMenuSystem.registeredMenus && pluginMenuSystem.registeredMenus['fpln-menu']);
            if (!fplnMenu || typeof fplnMenu.getItem !== 'function') {
                return;
            }
            const actLegItem = fplnMenu.getItem(9);
            if (actLegItem && actLegItem.disabled) {
                let canAct = false;
                if (mfdFplSelectedElement && typeof mfdFplSelectedElement === 'object' && ('leg' in mfdFplSelectedElement)) {
                    const loc = resolveLegIndexesInPrimaryPlan(mfdFplSelectedElement);
                    if (loc && submenuFms && typeof submenuFms.canActivateLeg === 'function') {
                        canAct = !!submenuFms.canActivateLeg(loc.segmentIndex, loc.segmentLegIndex);
                    }
                }
                actLegItem.disabled.set(!canAct);
                safeSetSimVar('L:CT182T_DBG_ACT_LEG_EN', 'Number', canAct ? 1 : 0);
            }
            if (typeof updateAtkOffsetSoftkeyState === 'function') {
                updateAtkOffsetSoftkeyState(fplnMenu);
            }
        } catch (e) {}
    }

    function openProcedureViewForType(procTypeKey, airportFacility) {
        if (!submenuViewService) {
            return false;
        }
        const garmin = window.garminsdk;
        const PT = (garmin && garmin.ProcedureType) ? garmin.ProcedureType : { DEPARTURE: 0, ARRIVAL: 1, APPROACH: 2 };
        try {
            if (isMfdContext) {
                const page = submenuViewService.open('SelectProcedurePage', true);
                if (!page || typeof page.setActiveProcedureType !== 'function') {
                    return false;
                }
                let pt = PT.APPROACH;
                if (procTypeKey === 'DEPARTURE') pt = PT.DEPARTURE;
                else if (procTypeKey === 'ARRIVAL') pt = PT.ARRIVAL;
                const procComp = page.setActiveProcedureType(pt);
                if (airportFacility && airportFacility.icao && procComp && procComp.controller && procComp.controller.inputIcao) {
                    procComp.controller.inputIcao.set(airportFacility.icao);
                    if (typeof setTimeout === 'function') {
                        setTimeout(function () {
                            try {
                                if (procComp.controller && typeof procComp.controller.gotoNextSelect === 'function') {
                                    procComp.controller.gotoNextSelect(false);
                                }
                            } catch (e) {}
                        }, 120);
                    }
                } else if (pt === PT.APPROACH && procComp && typeof procComp.initDefaults === 'function') {
                    procComp.initDefaults();
                }
                return true;
            } else {
                const pfdViewName = procTypeKey === 'DEPARTURE'
                    ? 'SelectDeparture'
                    : (procTypeKey === 'ARRIVAL' ? 'SelectArrival' : 'SelectApproach');
                const view = submenuViewService.open(pfdViewName, true);
                if (airportFacility && airportFacility.icao && view && view.controller && view.controller.inputIcao) {
                    view.controller.inputIcao.set(airportFacility.icao);
                }
                return true;
            }
        } catch (e) {
            return false;
        }
    }

    function executeHoldAtPresentPosition() {
        if (!submenuFms || !submenuBus || !submenuViewService) {
            return false;
        }
        try {
            const pos = getPlaneCoordinates();
            if (!pos) {
                return false;
            }
            let magCourse = 360;
            try {
                if (typeof SimVar !== 'undefined') {
                    const trk = Number(SimVar.GetSimVarValue('GPS GROUND MAGNETIC TRACK', 'degrees'));
                    const hdg = Number(SimVar.GetSimVarValue('PLANE HEADING DEGREES MAGNETIC', 'degrees'));
                    const gs = Number(SimVar.GetSimVarValue('GPS GROUND SPEED', 'knots'));
                    const raw = (gs > 3 && !isNaN(trk) && trk > 0) ? trk : hdg;
                    if (!isNaN(raw)) {
                        const norm = Math.round(((raw % 360) + 360) % 360);
                        magCourse = norm === 0 ? 360 : norm;
                    }
                }
            } catch (e) {}

            const pposFac = registerUserFacilityInRepo('PPOS', pos.lat, pos.lon, true, 'PRESENT POS');
            submenuFms.createDirectToRandom(pposFac, magCourse);
            const garmin = window.garminsdk;
            const dtoPlanIdx = (garmin && garmin.Fms && garmin.Fms.DTO_RANDOM_PLAN_INDEX !== undefined)
                ? garmin.Fms.DTO_RANDOM_PLAN_INDEX
                : 1;
            const holdView = submenuViewService.open('HoldAt', false);
            if (holdView && typeof holdView.setInput === 'function') {
                holdView.setInput({ segmentIndex: 0, legIndex: 2, planIndex: dtoPlanIdx });
                if (holdView.store && holdView.store.course) {
                    holdView.store.course.set(magCourse);
                }
            }
            return true;
        } catch (e) {
            console.error('CT182TGfc700Plugin: executeHoldAtPresentPosition error', e);
            return false;
        }
    }

    function updateAirportInfoSoftkeys() {
        if (!isMfdContext || !pluginMenuSystem) {
            return;
        }
        try {
            const menu = typeof pluginMenuSystem.getMenu === 'function'
                ? pluginMenuSystem.getMenu('wpt-airport-info-menu')
                : (pluginMenuSystem.registeredMenus && pluginMenuSystem.registeredMenus['wpt-airport-info-menu']);
            if (!menu || typeof menu.getItem !== 'function') {
                return;
            }
            const wpt = currentAirportInfoPage && currentAirportInfoPage.waypoint && currentAirportInfoPage.waypoint.get();
            const airport = wpt && wpt.facility && wpt.facility.get();
            const hasAirport = !!(airport && airport.icao);
            const hasRwy = !!(hasAirport && Array.isArray(airport.runways) && airport.runways.length > 0);
            const hasFreq = !!(hasAirport && Array.isArray(airport.frequencies) && airport.frequencies.length > 0);
            const hasApr = !!(hasAirport && ((Array.isArray(airport.approaches) && airport.approaches.length > 0) || hasRwy));
            const hasDp = !!(hasAirport && Array.isArray(airport.departures) && airport.departures.length > 0);
            const hasStar = !!(hasAirport && Array.isArray(airport.arrivals) && airport.arrivals.length > 0);

            if (menu.getItem(5) && menu.getItem(5).disabled) menu.getItem(5).disabled.set(!hasRwy);
            if (menu.getItem(6) && menu.getItem(6).disabled) menu.getItem(6).disabled.set(!hasFreq);
            if (menu.getItem(7) && menu.getItem(7).disabled) menu.getItem(7).disabled.set(!hasApr);
            if (menu.getItem(8) && menu.getItem(8).disabled) menu.getItem(8).disabled.set(!hasDp);
            if (menu.getItem(9) && menu.getItem(9).disabled) menu.getItem(9).disabled.set(!hasStar);
        } catch (e) {}
    }

    function patchEasyUsabilityUi() {
        try {
            const mods = [window.g1000nxipfd, window.g1000nximfd];
            for (let m = 0; m < mods.length; m++) {
                const mod = mods[m];
                if (!mod) {
                    continue;
                }

                // --- Item #1: Track MFD FPL selection for 'ACT Leg' softkey ---
                if (mod.MFDFPL && mod.MFDFPL.prototype && !mod.MFDFPL.prototype._wtActLegPatched) {
                    mod.MFDFPL.prototype._wtActLegPatched = true;
                    const origViewOpened = mod.MFDFPL.prototype.onViewOpened;
                    mod.MFDFPL.prototype.onViewOpened = function () {
                        const res = origViewOpened.apply(this, arguments);
                        try {
                            if (!this._wtSelSubscribed && this.selectionSub && typeof this.selectionSub.sub === 'function') {
                                this._wtSelSubscribed = true;
                                this.selectionSub.sub(function (sel) {
                                    mfdFplSelectedElement = sel;
                                    if (sel && typeof sel === 'object' && ('leg' in sel)) {
                                        lastMfdFplSelectedLeg = sel;
                                    }
                                    updateMfdFplSoftkeys();
                                }, true);
                            } else {
                                mfdFplSelectedElement = this.selectionSub ? this.selectionSub.get() : null;
                                if (mfdFplSelectedElement && typeof mfdFplSelectedElement === 'object' && ('leg' in mfdFplSelectedElement)) {
                                    lastMfdFplSelectedLeg = mfdFplSelectedElement;
                                }
                                updateMfdFplSoftkeys();
                            }
                        } catch (e) {}
                        return res;
                    };

                    const origBlurred = mod.MFDFPL.prototype.onBlurred;
                    mod.MFDFPL.prototype.onBlurred = function () {
                        const res = origBlurred.apply(this, arguments);
                        mfdFplSelectedElement = null;
                        updateMfdFplSoftkeys();
                        return res;
                    };

                    const origClosed = mod.MFDFPL.prototype.onViewClosed;
                    if (typeof origClosed === 'function') {
                        mod.MFDFPL.prototype.onViewClosed = function () {
                            lastMfdFplSelectedLeg = null;
                            lastFocusedFplFixCtrl = null;
                            return origClosed.apply(this, arguments);
                        };
                    }
                }

                // Track focused FixInfo row on both PFD & MFD for 1st-leg Hold & ATK Offset
                if (mod.G1000UiControl && mod.G1000UiControl.prototype && !mod.G1000UiControl.prototype._wtFixFocusPatched) {
                    mod.G1000UiControl.prototype._wtFixFocusPatched = true;
                    const origOnFocused = mod.G1000UiControl.prototype.onFocused;
                    mod.G1000UiControl.prototype.onFocused = function (source) {
                        const fixCtrl = (this.fixEl && this.props && this.props.data)
                            ? this
                            : ((this.parent && this.parent.fixEl && this.parent.props && this.parent.props.data) ? this.parent : null);
                        if (fixCtrl) {
                            focusedFplFixCtrl = fixCtrl;
                            lastFocusedFplFixCtrl = fixCtrl;
                        }
                        return origOnFocused.apply(this, arguments);
                    };
                    const origOnBlurred = mod.G1000UiControl.prototype.onBlurred;
                    mod.G1000UiControl.prototype.onBlurred = function (source) {
                        if (focusedFplFixCtrl === this || (this.parent && focusedFplFixCtrl === this.parent)) {
                            focusedFplFixCtrl = null;
                        }
                        return origOnBlurred.apply(this, arguments);
                    };
                }

                // --- Item #2: FPL Section Headers (Origin, Enroute, Destination, Procedures) ---
                const HdrDep = mod.FPLHeaderDeparture;
                if (HdrDep && HdrDep.prototype && !HdrDep.prototype._wtHdrPatched) {
                    HdrDep.prototype._wtHdrPatched = true;
                    const handleDepHdrKnob = function (hdr, openSubmenu) {
                        const fms = hdr.props && hdr.props.fms;
                        const vs = submenuViewService;
                        if (!fms || !vs) return false;
                        registerSubmenuFms(fms);
                        const plan = fms.getFlightPlan();
                        const origin = plan.originAirport;
                        if (!origin) {
                            if (openSubmenu) autoOpenSubmenuUntil = Date.now() + 800;
                            vs.open('WptInfo', true).onAccept.on(function (sender, fac) {
                                if (!fac) return;
                                if ('bestApproach' in fac) {
                                    fms.setOrigin(fac);
                                    vs.open('SetRunway', true).setInput(fac).onAccept.on(function (s2, rwy) {
                                        fms.setOrigin((hdr.props.facilities && hdr.props.facilities.originFacility) || fac, rwy);
                                    });
                                } else {
                                    const firstEnr = plan.segmentsOfType(sdk.FlightPlanSegmentType.Enroute).next().value;
                                    if (firstEnr) fms.insertWaypoint(firstEnr.segmentIndex, fac, 0);
                                }
                            });
                            return true;
                        }
                        if (plan.procedureDetails.departureIndex < 0 && hdr.props.facilities && hdr.props.facilities.originFacility) {
                            vs.open('SetRunway', true).setInput(hdr.props.facilities.originFacility).onAccept.on(function (s2, rwy) {
                                fms.setOrigin(hdr.props.facilities.originFacility, rwy);
                            });
                            return true;
                        }
                        return false;
                    };
                    HdrDep.prototype.onUpperKnobInc = function () { return handleDepHdrKnob(this, false); };
                    HdrDep.prototype.onUpperKnobDec = function () { return handleDepHdrKnob(this, true); };
                    HdrDep.prototype.onEnter = function () {
                        const fms = this.props && this.props.fms;
                        if (fms) {
                            const plan = fms.getFlightPlan();
                            if (plan && plan.procedureDetails && plan.procedureDetails.departureIndex > -1) {
                                const origFac = this.props.facilities && this.props.facilities.originFacility;
                                return openProcedureViewForType('DEPARTURE', origFac);
                            }
                        }
                        return handleDepHdrKnob(this, false);
                    };
                }

                const HdrEnr = mod.FPLHeaderEnroute;
                if (HdrEnr && HdrEnr.prototype && !HdrEnr.prototype._wtHdrPatched) {
                    HdrEnr.prototype._wtHdrPatched = true;
                    const handleEnrHdrKnob = function (hdr, openSubmenu) {
                        const fms = hdr.props && hdr.props.fms;
                        const seg = hdr.props && hdr.props.segment;
                        const vs = submenuViewService;
                        if (!fms || !vs || !seg || seg.airway !== undefined) return false;
                        registerSubmenuFms(fms);
                        if (openSubmenu) autoOpenSubmenuUntil = Date.now() + 800;
                        vs.open('WptInfo', true).onAccept.on(function (sender, fac) {
                            if (fac) {
                                fms.insertWaypoint(seg.segmentIndex, fac, 0);
                            }
                        });
                        return true;
                    };
                    HdrEnr.prototype.onUpperKnobInc = function () { return handleEnrHdrKnob(this, false); };
                    HdrEnr.prototype.onUpperKnobDec = function () { return handleEnrHdrKnob(this, true); };
                }

                const HdrDest = mod.FPLHeaderDestination;
                if (HdrDest && HdrDest.prototype && !HdrDest.prototype._wtHdrPatched) {
                    HdrDest.prototype._wtHdrPatched = true;
                    const handleDestHdrKnob = function (hdr, openSubmenu) {
                        const fms = hdr.props && hdr.props.fms;
                        const vs = submenuViewService;
                        if (!fms || !vs) return false;
                        registerSubmenuFms(fms);
                        const plan = fms.getFlightPlan();
                        const dest = plan.destinationAirport;
                        if (!dest) {
                            if (openSubmenu) autoOpenSubmenuUntil = Date.now() + 800;
                            vs.open('WptInfo', true).onAccept.on(function (sender, fac) {
                                if (!fac) return;
                                if ('bestApproach' in fac) {
                                    fms.setDestination(fac);
                                    vs.open('SetRunway', true).setInput(fac).onAccept.on(function (s2, rwy) {
                                        fms.setDestination((hdr.props.facilities && hdr.props.facilities.destinationFacility) || fac, rwy);
                                    });
                                } else {
                                    const enrIdx = fms.findLastEnrouteSegmentIndex(plan);
                                    const enrSeg = plan.tryGetSegment(enrIdx);
                                    if (enrSeg) fms.insertWaypoint(enrIdx, fac, enrSeg.legs.length);
                                }
                            });
                            return true;
                        }
                        if (plan.procedureDetails.arrivalIndex < 0 && plan.procedureDetails.approachIndex < 0 && hdr.props.facilities && hdr.props.facilities.destinationFacility) {
                            vs.open('SetRunway', true).setInput(hdr.props.facilities.destinationFacility).onAccept.on(function (s2, rwy) {
                                fms.setDestination(hdr.props.facilities.destinationFacility, rwy);
                            });
                            return true;
                        }
                        return false;
                    };
                    HdrDest.prototype.onUpperKnobInc = function () { return handleDestHdrKnob(this, false); };
                    HdrDest.prototype.onUpperKnobDec = function () { return handleDestHdrKnob(this, true); };
                    HdrDest.prototype.onEnter = function () { return handleDestHdrKnob(this, false); };
                    HdrDest.prototype.onClr = function () {
                        const fms = this.props && this.props.fms;
                        const vs = submenuViewService;
                        if (!fms || !vs) return false;
                        const plan = fms.getFlightPlan();
                        const dest = plan && plan.destinationAirport;
                        if (dest && plan.procedureDetails.arrivalIndex < 0 && plan.procedureDetails.approachIndex < 0) {
                            vs.open('MessageDialog', true).setInput({
                                inputString: 'Remove ' + sdk.ICAO.getIdent(dest).trim() + '?',
                                hasRejectButton: true
                            }).onAccept.on(function (s, accept) {
                                if (accept) fms.setDestination(undefined);
                            });
                            return true;
                        }
                        return false;
                    };
                }

                const HdrArr = mod.FPLHeaderArrival;
                if (HdrArr && HdrArr.prototype && !HdrArr.prototype._wtHdrPatched) {
                    HdrArr.prototype._wtHdrPatched = true;
                    HdrArr.prototype.onEnter = function () {
                        const fms = this.props && this.props.fms;
                        if (fms) {
                            const plan = fms.getPrimaryFlightPlan();
                            if (plan && plan.procedureDetails && plan.procedureDetails.arrivalIndex > -1) {
                                const arrFac = this.props.facilities && this.props.facilities.arrivalFacility;
                                return openProcedureViewForType('ARRIVAL', arrFac);
                            }
                        }
                        return false;
                    };
                }

                const HdrAppr = mod.FPLHeaderApproach;
                if (HdrAppr && HdrAppr.prototype && !HdrAppr.prototype._wtHdrPatched) {
                    HdrAppr.prototype._wtHdrPatched = true;
                    HdrAppr.prototype.onEnter = function () {
                        const fms = this.props && this.props.fms;
                        const garmin = window.garminsdk;
                        if (fms && garmin && garmin.FmsUtils) {
                            const plan = fms.getPrimaryFlightPlan();
                            if (plan && garmin.FmsUtils.isApproachLoaded(plan)) {
                                const destFac = this.props.facilities && this.props.facilities.destinationFacility;
                                return openProcedureViewForType('APPROACH', destFac);
                            }
                        }
                        return false;
                    };
                }

                // --- Item #3: WPT Information Pages Direct-To pre-fill, MENU & Softkeys ---
                const BaseMfdPage = mod.MFDUiPage;
                if (BaseMfdPage && BaseMfdPage.prototype && !BaseMfdPage.prototype._wtNavigraphDtoPatched) {
                    BaseMfdPage.prototype._wtNavigraphDtoPatched = true;
                    const origMfdPageDto = BaseMfdPage.prototype.onDirectToPressed;
                    BaseMfdPage.prototype.onDirectToPressed = function () {
                        const ngApt = this.airport && typeof this.airport.get === 'function' ? this.airport.get() : null;
                        if (ngApt && ngApt.icao && this.props && this.props.viewService) {
                            const dlg = this.props.viewService.open('DirectTo');
                            if (dlg && typeof dlg.setInput === 'function') {
                                dlg.setInput({ icao: ngApt.icao });
                            }
                            return true;
                        }
                        return origMfdPageDto ? origMfdPageDto.apply(this, arguments) : false;
                    };
                }
                const InfoPage = mod.MFDInformationPage;
                if (InfoPage && InfoPage.prototype && !InfoPage.prototype._wtWptInfoPagePatched) {
                    InfoPage.prototype._wtWptInfoPagePatched = true;
                    InfoPage.prototype.onDirectToPressed = function () {
                        const wpt = this.waypoint && this.waypoint.get();
                        const fac = wpt && wpt.facility && wpt.facility.get();
                        const dlg = this.props.viewService.open('DirectTo');
                        if (fac && fac.icao && dlg && typeof dlg.setInput === 'function') {
                            dlg.setInput({ icao: fac.icao });
                        }
                        return true;
                    };
                }

                const AptInfoPage = mod.MFDAirportInformationPage;
                if (AptInfoPage && AptInfoPage.prototype && !AptInfoPage.prototype._wtAptInfoPatched) {
                    AptInfoPage.prototype._wtAptInfoPatched = true;

                    const origAptSelected = AptInfoPage.prototype.onSelected;
                    AptInfoPage.prototype.onSelected = function (waypoint) {
                        const res = origAptSelected.apply(this, arguments);
                        currentAirportInfoPage = this;
                        updateAirportInfoSoftkeys();
                        return res;
                    };

                    const origAptOpened = AptInfoPage.prototype.onViewOpened;
                    AptInfoPage.prototype.onViewOpened = function () {
                        const res = origAptOpened.apply(this, arguments);
                        currentAirportInfoPage = this;
                        try {
                            if (this.props && this.props.menuSystem && this.props.menuSystem.registeredMenus && this.props.menuSystem.registeredMenus['wpt-airport-info-menu']) {
                                this.props.menuSystem.clear();
                                this.props.menuSystem.pushMenu('wpt-airport-info-menu');
                            }
                            updateAirportInfoSoftkeys();
                        } catch (e) {}
                        return res;
                    };

                    AptInfoPage.prototype.onMenuPressed = function () {
                        const self = this;
                        const wpt = self.waypoint && self.waypoint.get();
                        const airport = wpt && wpt.facility && wpt.facility.get();
                        const hasAirport = !!(airport && airport.icao);
                        const hasRwy = !!(hasAirport && Array.isArray(airport.runways) && airport.runways.length > 0);
                        const hasFreq = !!(hasAirport && Array.isArray(airport.frequencies) && airport.frequencies.length > 0);
                        const focusGroup = function (grpRef) {
                            if (grpRef && grpRef.instance) {
                                self.setScrollEnabled(true);
                                if (self.uiRoot && self.uiRoot.instance && !self.uiRoot.instance.isFocused) {
                                    self.uiRoot.instance.focus(sdk.FocusPosition.MostRecent);
                                }
                                grpRef.instance.focus(sdk.FocusPosition.First);
                            }
                        };
                        const dialog = self.props.viewService.open('PageMenuDialog');
                        dialog.setMenuItems([
                            {
                                id: 'apt-win',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Airport Window'); },
                                isEnabled: true,
                                action: function () { focusGroup(self.facilityGroup); }
                            },
                            {
                                id: 'rwy-win',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Runway Window'); },
                                isEnabled: hasRwy,
                                action: function () { focusGroup(self.runwaysGroup); }
                            },
                            {
                                id: 'freq-win',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Frequency Window'); },
                                isEnabled: hasFreq,
                                action: function () { focusGroup(self.frequenciesGroup); }
                            },
                            {
                                id: 'load-apr',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Approach'); },
                                isEnabled: hasAirport,
                                action: function () { openProcedureViewForType('APPROACH', airport); }
                            },
                            {
                                id: 'load-dep',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Departure'); },
                                isEnabled: hasAirport && Array.isArray(airport.departures) && airport.departures.length > 0,
                                action: function () { openProcedureViewForType('DEPARTURE', airport); }
                            },
                            {
                                id: 'load-arr',
                                renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select Arrival'); },
                                isEnabled: hasAirport && Array.isArray(airport.arrivals) && airport.arrivals.length > 0,
                                action: function () { openProcedureViewForType('ARRIVAL', airport); }
                            }
                        ]);
                        return true;
                    };
                }

                // --- Item #7 (plus hooks for Batch 2 menus): PageMenuDialog item enhancer ---
                const MenuDlg = mod.ListMenuDialog;
                if (MenuDlg && MenuDlg.prototype && !MenuDlg.prototype._wtMenuEnhancerPatched) {
                    MenuDlg.prototype._wtMenuEnhancerPatched = true;
                    const origSetMenuItems = MenuDlg.prototype.setMenuItems;
                    MenuDlg.prototype.setMenuItems = function (items) {
                        try {
                            if (Array.isArray(items)) {
                                for (let i = 0; i < items.length; i++) {
                                    const it = items[i];
                                    if (!it || !it.id) continue;

                                    // Item #7a: Enable 'Hold At Present Position'
                                    if (it.id === 'hold-ppos') {
                                        it.isEnabled = !!(submenuFms && getPlaneCoordinates());
                                        it.action = function () {
                                            executeHoldAtPresentPosition();
                                        };
                                    }
                                    // Item #7b: Unblock 'Hold At Waypoint' on 1st leg of flight plan (where prevLeg is null)
                                    else if (it.id === 'hold-waypoint' && !it.isEnabled) {
                                        const fxCtrl = focusedFplFixCtrl || lastFocusedFplFixCtrl;
                                        let legDef = null;
                                        if (fxCtrl && fxCtrl.props && fxCtrl.props.data) {
                                            const raw = fxCtrl.props.data;
                                            const unw = typeof raw.get === 'function' ? raw.get() : raw;
                                            legDef = unw && (unw.legDefinition || (unw.leg && unw.leg.leg ? unw.leg : unw));
                                        } else if (isMfdContext && (mfdFplSelectedElement || lastMfdFplSelectedLeg)) {
                                            legDef = mfdFplSelectedElement || lastMfdFplSelectedLeg;
                                        }
                                        const loc = legDef ? resolveLegIndexesInPrimaryPlan(legDef) : null;
                                        if (loc && legDef && legDef.leg && isFixTerminatingLegType(legDef.leg.type)) {
                                            it.isEnabled = true;
                                            it.action = function () {
                                                if (!submenuViewService) return;
                                                const holdView = submenuViewService.open('HoldAt', true);
                                                if (holdView && typeof holdView.setInput === 'function') {
                                                    holdView.setInput({ planIndex: 0, segmentIndex: loc.segmentIndex, legIndex: loc.segmentLegIndex });
                                                    if (holdView.store && holdView.store.course && holdView.store.course.get() === 0) {
                                                        let crs = 360;
                                                        try {
                                                            const hdg = Number(SimVar.GetSimVarValue('PLANE HEADING DEGREES MAGNETIC', 'degrees'));
                                                            if (!isNaN(hdg) && hdg > 0) crs = Math.round(hdg);
                                                        } catch (e) {}
                                                        holdView.store.course.set(crs);
                                                    }
                                                }
                                            };
                                        }
                                    }

                                    // Hook point for Batch 2 Medium menu items (ATK Offset, Store FPL, User WPT, Closest Point)
                                    if (typeof enhanceMediumMenuItems === 'function') {
                                        enhanceMediumMenuItems(it, mod);
                                    }
                                }
                            }
                        } catch (e) {}
                        return origSetMenuItems.call(this, items);
                    };
                }
            }
        } catch (e) {
            console.error('CT182TGfc700Plugin: patchEasyUsabilityUi error', e);
        }
    }

    function installEasyUsabilityMenuHooks(menuSys) {
        if (!menuSys) {
            return;
        }
        pluginMenuSystem = menuSys;
        if (!isMfdContext || menuSys._wtMenusWired) {
            return;
        }
        try {
            const mfdMod = window.g1000nximfd;

            // 1. Wire 'ACT Leg' softkey (index 9) on MFDFPLRootMenu ('fpln-menu')
            const fplnMenu = typeof menuSys.getMenu === 'function' ? menuSys.getMenu('fpln-menu') : (menuSys.registeredMenus && menuSys.registeredMenus['fpln-menu']);
            if (!fplnMenu) {
                return; // Wait until onMenuSystemInitialized() after menus are registered!
            }
            menuSys._wtMenusWired = true;
            if (fplnMenu && typeof fplnMenu.getItem === 'function') {
                const actLegItem = fplnMenu.getItem(9);
                if (actLegItem) {
                    actLegItem.handler = function () {
                        if (!mfdFplSelectedElement || !('leg' in mfdFplSelectedElement) || !submenuFms || !submenuViewService || !mfdMod || !mfdMod.FPLUtils) {
                            return;
                        }
                        const loc = resolveLegIndexesInPrimaryPlan(mfdFplSelectedElement);
                        if (loc && submenuFms.canActivateLeg(loc.segmentIndex, loc.segmentLegIndex)) {
                            mfdMod.FPLUtils.openActivateLegDialog(submenuFms, loc.segmentIndex, loc.segmentLegIndex, submenuViewService);
                        }
                    };
                    updateMfdFplSoftkeys();
                }
            }

            // 2. Register 'wpt-airport-info-menu' for WPT -> Airport Information page
            if (mfdMod && mfdMod.SoftKeyMenu && typeof menuSys.addMenu === 'function') {
                const aptMenu = new mfdMod.SoftKeyMenu(menuSys);
                aptMenu.addItem(0, 'Engine', function () { menuSys.pushMenu('engine-menu'); });
                aptMenu.addItem(2, 'Map Opt', function () { menuSys.pushMenu('map-opt'); });
                const focusAptGrp = function (propName) {
                    if (!currentAirportInfoPage) return;
                    const grp = currentAirportInfoPage[propName];
                    if (grp && grp.instance) {
                        currentAirportInfoPage.setScrollEnabled(true);
                        if (currentAirportInfoPage.uiRoot && currentAirportInfoPage.uiRoot.instance && !currentAirportInfoPage.uiRoot.instance.isFocused) {
                            currentAirportInfoPage.uiRoot.instance.focus(sdk.FocusPosition.MostRecent);
                        }
                        grp.instance.focus(sdk.FocusPosition.First);
                    }
                };
                const openAptProc = function (typeKey) {
                    if (!currentAirportInfoPage || !currentAirportInfoPage.waypoint) return;
                    const wpt = currentAirportInfoPage.waypoint.get();
                    const airport = wpt && wpt.facility && wpt.facility.get();
                    if (airport && airport.icao) {
                        openProcedureViewForType(typeKey, airport);
                    }
                };
                aptMenu.addItem(4, 'APT', function () { focusAptGrp('facilityGroup'); });
                aptMenu.addItem(5, 'RNWY', function () { focusAptGrp('runwaysGroup'); }, undefined, true);
                aptMenu.addItem(6, 'FREQ', function () { focusAptGrp('frequenciesGroup'); }, undefined, true);
                aptMenu.addItem(7, 'APR', function () { openAptProc('APPROACH'); }, undefined, true);
                aptMenu.addItem(8, 'DP', function () { openAptProc('DEPARTURE'); }, undefined, true);
                aptMenu.addItem(9, 'STAR', function () { openAptProc('ARRIVAL'); }, undefined, true);
                menuSys.addMenu('wpt-airport-info-menu', aptMenu);
                updateAirportInfoSoftkeys();
            }

            if (typeof installMediumSoftkeyHooks === 'function') {
                installMediumSoftkeyHooks(menuSys);
            }
        } catch (e) {
            console.error('CT182TGfc700Plugin: installEasyUsabilityMenuHooks error', e);
        }
    }

    let easyBusHooksInstalled = false;
    function installEasyUsabilityBusHooks(binder) {
        if (shouldInstallG1000Enhancements) {
        patchEasyUsabilityUi();
    }
        if (!binder || !binder.bus || easyBusHooksInstalled) {
            return;
        }
        easyBusHooksInstalled = true;

        try {
            if (binder.fms && binder.fms.flightPlanner && typeof binder.fms.flightPlanner.onEvent === 'function') {
                binder.fms.flightPlanner.onEvent('fplActiveLegChange').handle(updateMfdFplSoftkeys);
                binder.fms.flightPlanner.onEvent('fplLegChange').handle(updateMfdFplSoftkeys);
                binder.fms.flightPlanner.onEvent('fplSegmentChange').handle(updateMfdFplSoftkeys);
            }
        } catch (e) {}

        // Item #18: 121.500 MHz Emergency COM Hold + BARO Transition & Arrival Advisories (run once on MFD)
        if (isMfdContext) {
            try {
                const sub = binder.bus.getSubscriber();
                sub.on('hEvent').handle(function (hEvt) {
                    if (hEvt === 'AS1000_PFD_COM_Switch_Long' || hEvt === 'AS1000_MFD_COM_Switch_Long') {
                        const now = Date.now();
                        if ((now - lastComLongSwapMs) < 500) {
                            return;
                        }
                        lastComLongSwapMs = now;
                        try {
                            if (typeof SimVar !== 'undefined') {
                                SimVar.SetSimVarValue('K:COM_STBY_RADIO_SET_HZ', 'Hz', 121500000).then(function () {
                                    SimVar.SetSimVarValue('K:COM1_RADIO_SWAP', 'Number', 0);
                                });
                                safeSetSimVar('L:CT182T_DBG_EMERG_1215', 'Number', 1);
                            }
                        } catch (e) {}
                    }
                });

                if (typeof setInterval === 'function' && typeof SimVar !== 'undefined') {
                    const pub = binder.bus.getPublisher();
                    setInterval(function () {
                        try {
                            // 1. BARO Transition Alert (18,000 FT / FL180)
                            if (baroAlertEnabled) {
                                const indAlt = Number(SimVar.GetSimVarValue('INDICATED ALTITUDE', 'feet'));
                                const kohlsman = Number(SimVar.GetSimVarValue('KOHLSMAN SETTING HG:1', 'inHg'));
                                if (!isNaN(indAlt) && !isNaN(kohlsman) && kohlsman > 25) {
                                    const isStd = Math.abs(kohlsman - 29.92) < 0.015;
                                    if (indAlt >= 18050) {
                                        wasAboveTransAlt = true;
                                        if (!isStd && !baroClimbAlertActive) {
                                            baroClimbAlertActive = true;
                                            pub.pub('alerts_push', {
                                                key: 'wt-baro-std-climb',
                                                title: 'BARO STD',
                                                message: 'Climbing above 18000FT. Set STD BARO (29.92).'
                                            }, true, false);
                                        } else if (isStd && baroClimbAlertActive) {
                                            baroClimbAlertActive = false;
                                            pub.pub('alerts_remove', 'wt-baro-std-climb', true, false);
                                        }
                                    } else if (indAlt <= 17900) {
                                        if (baroClimbAlertActive) {
                                            baroClimbAlertActive = false;
                                            pub.pub('alerts_remove', 'wt-baro-std-climb', true, false);
                                        }
                                        if (wasAboveTransAlt && isStd && !baroDescAlertActive) {
                                            baroDescAlertActive = true;
                                            pub.pub('alerts_push', {
                                                key: 'wt-baro-local-desc',
                                                title: 'BARO TRANS',
                                                message: 'Descending below FL180. Set local altimeter.'
                                            }, true, false);
                                        } else if (!isStd && baroDescAlertActive) {
                                            baroDescAlertActive = false;
                                            wasAboveTransAlt = false;
                                            pub.pub('alerts_remove', 'wt-baro-local-desc', true, false);
                                        }
                                    }
                                }
                            }

                            // 2. Arrival Alert (within 1.0 NM of destination airport)
                            if (arrivalAlertEnabled && submenuFms && typeof submenuFms.hasPrimaryFlightPlan === 'function' && submenuFms.hasPrimaryFlightPlan()) {
                                const plan = submenuFms.getPrimaryFlightPlan();
                                const destIcao = plan.destinationAirport || '';
                                if (!destIcao && arrivalAlertActiveForDest) {
                                    arrivalAlertActiveForDest = '';
                                    pub.pub('alerts_remove', 'wt-arrival-alert', true, false);
                                } else if (destIcao && submenuFms.facLoader) {
                                    const pos = getPlaneCoordinates();
                                    const onGnd = Number(SimVar.GetSimVarValue('SIM ON GROUND', 'Bool'));
                                    if (pos && !onGnd) {
                                        submenuFms.facLoader.getFacility(sdk.FacilityType.Airport, destIcao).then(function (fac) {
                                            if (!fac) return;
                                            const distNm = computeDistanceRad(pos.lat, pos.lon, fac.lat, fac.lon) * (180 / Math.PI) * 60;
                                            if (distNm <= 1.0 && arrivalAlertActiveForDest !== destIcao) {
                                                arrivalAlertActiveForDest = destIcao;
                                                pub.pub('alerts_push', {
                                                    key: 'wt-arrival-alert',
                                                    title: 'ARRIVAL',
                                                    message: 'Arriving at destination ' + sdk.ICAO.getIdent(destIcao).trim() + '.'
                                                }, true, false);
                                            } else if (distNm > 2.5 && arrivalAlertActiveForDest === destIcao) {
                                                arrivalAlertActiveForDest = '';
                                                pub.pub('alerts_remove', 'wt-arrival-alert', true, false);
                                            }
                                        }).catch(function () {});
                                    }
                                }
                            }
                        } catch (e) {}
                    }, 2000);
                }
            } catch (e) {}
        }
    }

    if (shouldInstallG1000Enhancements) {
        patchEasyUsabilityUi();
    }

    // =========================================================================
    // 1D. WTG1000 NXi Usability Fixes — Batch 2 (Medium Items):
    //     - Item #4: Along-Track Offsets ('ATK OFS' softkey & 'Create ATK Offset WPT')
    //     - Item #5: Direct-To interactive VNV Altitude & Offset (PFD & MFD)
    //     - Item #6: Waypoint lookup by Facility Name & City Name
    //     - Item #8: Map Pointer feature snap, ENT info, D->, Load WPT & Measure BRG/DIS
    //     - Item #9: MFD Wide / Narrow FPL view + CUM / Leg-Leg totals
    //     - Item #10: Store Flight Plan & Flight Plan Catalog MFD page
    //     - Item #11: Create User Waypoint ('New WPT') & User WPT Information page
    //     - Item #13: Nearest Frequencies & Nearest User WPTs MFD pages
    //     - Item #15 & #16: Cold-Weather Temperature Compensation & Closest Point of FPL
    // =========================================================================

    const USER_WPTS_STORAGE_KEY = 'WTG1000_NXI_USER_WPTS_V1';
    const TEMP_USER_WPTS_STORAGE_KEY = 'WTG1000_NXI_TEMP_USER_WPTS_V1';
    const STORED_FPLS_STORAGE_KEY = 'WTG1000_NXI_STORED_FPLS_V1';
    const facilityDirectory = new Map(); // icao -> { icao, ident, name, nameUpper, city, cityUpper, lat, lon, facType, frequencies, runways }

    function cleanTranslatedStr(raw) {
        if (!raw || typeof raw !== 'string') {
            return '';
        }
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.Translate === 'function') {
                const tr = Utils.Translate(raw);
                if (tr && typeof tr === 'string') {
                    return tr.trim();
                }
            }
        } catch (e) {}
        return raw.trim();
    }

    function indexFacilityInDirectory(fac) {
        if (!fac || !fac.icao || !isSelectableWaypointIcao(fac.icao)) {
            return;
        }
        try {
            const ident = sdk.ICAO.getIdent(fac.icao).trim();
            const name = cleanTranslatedStr(fac.name || '');
            const rawCity = String(fac.city || '');
            const cityParts = rawCity.split(', ');
            const city = cityParts.length > 1
                ? (cleanTranslatedStr(cityParts[0]) + ' ' + cleanTranslatedStr(cityParts[1]).substr(0, 2).toUpperCase()).trim()
                : cleanTranslatedStr(rawCity);
            facilityDirectory.set(fac.icao, {
                icao: fac.icao,
                ident: ident,
                name: name,
                nameUpper: name.toUpperCase(),
                city: city,
                cityUpper: city.toUpperCase(),
                lat: typeof fac.lat === 'number' ? fac.lat : NaN,
                lon: typeof fac.lon === 'number' ? fac.lon : NaN,
                facType: sdk.ICAO.getFacilityType(fac.icao),
                frequencies: Array.isArray(fac.frequencies) ? fac.frequencies : [],
                runways: Array.isArray(fac.runways) ? fac.runways : [],
                rawFacility: fac
            });
        } catch (e) {}
    }

    function hydrateMissingUserFacilityFromStorage(icao) {
        if (!icao || typeof icao !== 'string' || icao.charAt(0) !== 'U' || facilityDirectory.has(icao)) {
            return;
        }
        try {
            const pools = [loadStoredUserWaypoints(), loadTempUserWaypoints()];
            for (let p = 0; p < pools.length; p++) {
                const arr = pools[p];
                for (let i = 0; i < arr.length; i++) {
                    const u = arr[i];
                    if (u && (u.icao === icao || makeUserIcao(u.ident) === icao) && typeof u.lat === 'number' && typeof u.lon === 'number') {
                        registerUserFacilityInRepo(u.ident, u.lat, u.lon, p === 1, u.name || u.ident, true);
                        return;
                    }
                }
            }
        } catch (e) {}
    }

    function patchFacilityLoaderDirectoryHook() {
        try {
            if (sdk && sdk.FacilityLoader && sdk.FacilityLoader.prototype && !sdk.FacilityLoader.prototype.getFacility._wtDirWrapped) {
                const origGetFac = sdk.FacilityLoader.prototype.getFacility;
                const wrappedGetFac = function (type, icao) {
                    if (typeof icao === 'string' && icao.charAt(0) === 'U') {
                        hydrateMissingUserFacilityFromStorage(icao);
                    }
                    const p = origGetFac.apply(this, arguments);
                    if (p && typeof p.then === 'function') {
                        return p.then(function (fac) {
                            if (fac) {
                                indexFacilityInDirectory(fac);
                            }
                            return fac;
                        });
                    }
                    if (p) {
                        indexFacilityInDirectory(p);
                    }
                    return p;
                };
                wrappedGetFac._wtDirWrapped = true;
                sdk.FacilityLoader.prototype.getFacility = wrappedGetFac;
            }
        } catch (e) {}
    }

    function computeBearingDegTrue(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const toDeg = 180 / Math.PI;
        const p1 = lat1 * toRad;
        const p2 = lat2 * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const y = Math.sin(dLon) * Math.cos(p2);
        const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
        return ((Math.atan2(y, x) * toDeg) + 360) % 360;
    }

    function offsetLatLonByBearingDist(latDeg, lonDeg, bearingDegTrue, distNm) {
        const toRad = Math.PI / 180;
        const toDeg = 180 / Math.PI;
        const angDist = (distNm / 60) * toRad;
        const brng = bearingDegTrue * toRad;
        const lat1 = latDeg * toRad;
        const lon1 = lonDeg * toRad;
        const sinLat1 = Math.sin(lat1);
        const cosLat1 = Math.cos(lat1);
        const sinAd = Math.sin(angDist);
        const cosAd = Math.cos(angDist);
        const sinLat2 = sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(brng);
        const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
        const lon2 = lon1 + Math.atan2(Math.sin(brng) * sinAd * cosLat1, cosAd - sinLat1 * sinLat2);
        let lonNorm = (lon2 * toDeg);
        while (lonNorm > 180) lonNorm -= 360;
        while (lonNorm < -180) lonNorm += 360;
        return { lat: lat2 * toDeg, lon: lonNorm };
    }

    function makeUserIcao(ident) {
        const clean = String(ident || 'USR01').toUpperCase().replace(/[^A-Z0-9+-]/g, '').substr(0, 6).padEnd(6, ' ');
        return 'U     ' + clean;
    }

    function loadTempUserWaypoints() {
        try {
            if (typeof localStorage === 'undefined') return [];
            const raw = localStorage.getItem(TEMP_USER_WPTS_STORAGE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveTempUserWaypointEntry(ident, icao, lat, lon, name) {
        try {
            if (typeof localStorage === 'undefined') return;
            const list = loadTempUserWaypoints().filter(function (x) { return x && x.icao !== icao; });
            list.unshift({ ident: ident, icao: icao, lat: lat, lon: lon, name: name || ident });
            localStorage.setItem(TEMP_USER_WPTS_STORAGE_KEY, JSON.stringify(list.slice(0, 60)));
        } catch (e) {}
    }

    function registerUserFacilityInRepo(ident, lat, lon, isTemporary, displayName, skipBroadcast) {
        const icao = makeUserIcao(ident);
        let userFac = null;
        if (sdk.UserFacilityUtils && typeof sdk.UserFacilityUtils.createFromLatLon === 'function') {
            userFac = sdk.UserFacilityUtils.createFromLatLon(icao, lat, lon, !!isTemporary, displayName || ident);
        } else {
            userFac = {
                icao: icao,
                name: displayName || ident,
                lat: lat,
                lon: lon,
                region: '',
                city: '',
                isTemporary: !!isTemporary,
                userFacilityType: 2,
                magvar: (typeof MagVar !== 'undefined' && typeof MagVar.get === 'function') ? MagVar.get(lat, lon) : 0
            };
        }
        if (submenuBus && sdk.FacilityRepository && typeof sdk.FacilityRepository.getRepository === 'function') {
            try {
                const repo = sdk.FacilityRepository.getRepository(submenuBus);
                if (repo && typeof repo.add === 'function') {
                    repo.add(userFac);
                }
            } catch (e) {}
        }
        indexFacilityInDirectory(userFac);
        if (!skipBroadcast) {
            if (isTemporary) {
                saveTempUserWaypointEntry(String(ident || '').trim(), icao, lat, lon, displayName || ident);
            }
            if (submenuBus && typeof submenuBus.getPublisher === 'function') {
                try {
                    submenuBus.getPublisher().pub('wt_ct182t_user_fac_sync', {
                        ident: String(ident || '').trim(),
                        lat: lat,
                        lon: lon,
                        isTemporary: !!isTemporary,
                        name: displayName || ident
                    }, true, false);
                } catch (e) {}
            }
        }
        return userFac;
    }

    // --- Persisted User Waypoints (Item #11) ---
    function loadStoredUserWaypoints() {
        try {
            if (typeof localStorage === 'undefined') return [];
            const raw = localStorage.getItem(USER_WPTS_STORAGE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveStoredUserWaypoints(list) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(USER_WPTS_STORAGE_KEY, JSON.stringify(list.slice(0, 100)));
            }
        } catch (e) {}
    }

    function restorePersistedUserWaypointsToRepo() {
        const list = loadStoredUserWaypoints();
        for (let i = 0; i < list.length; i++) {
            const u = list[i];
            if (u && u.ident && typeof u.lat === 'number' && typeof u.lon === 'number') {
                registerUserFacilityInRepo(u.ident, u.lat, u.lon, false, u.name || 'USER WAYPOINT');
            }
        }
    }

    function addPersistedUserWaypoint(ident, lat, lon, comment) {
        const cleanIdent = String(ident || '').toUpperCase().replace(/[^A-Z0-9]/g, '').substr(0, 6);
        if (!cleanIdent || isNaN(lat) || isNaN(lon)) {
            return null;
        }
        const fac = registerUserFacilityInRepo(cleanIdent, lat, lon, false, comment || 'USER WAYPOINT');
        const list = loadStoredUserWaypoints().filter(function (x) { return x && x.ident !== cleanIdent; });
        list.unshift({ ident: cleanIdent, icao: fac.icao, lat: lat, lon: lon, name: comment || 'USER WAYPOINT' });
        saveStoredUserWaypoints(list);
        refreshUserWaypoints(null, null);
        return fac;
    }

    function deletePersistedUserWaypoint(ident) {
        const cleanIdent = String(ident || '').trim().toUpperCase();
        const list = loadStoredUserWaypoints().filter(function (x) { return x && x.ident !== cleanIdent; });
        saveStoredUserWaypoints(list);
        try {
            if (submenuBus && sdk.FacilityRepository) {
                const repo = sdk.FacilityRepository.getRepository(submenuBus);
                if (repo && typeof repo.remove === 'function') {
                    repo.remove(makeUserIcao(cleanIdent));
                }
            }
        } catch (e) {}
        facilityDirectory.delete(makeUserIcao(cleanIdent));
        refreshUserWaypoints(null, null);
    }

    // --- Stored Flight Plans (Item #10) ---
    function loadStoredFlightPlans() {
        try {
            if (typeof localStorage === 'undefined') return [];
            const raw = localStorage.getItem(STORED_FPLS_STORAGE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveStoredFlightPlans(list) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(STORED_FPLS_STORAGE_KEY, JSON.stringify(list.slice(0, 99)));
            }
        } catch (e) {}
    }

    function storeCurrentPrimaryFlightPlan() {
        if (!submenuFms || typeof submenuFms.hasPrimaryFlightPlan !== 'function' || !submenuFms.hasPrimaryFlightPlan()) {
            return null;
        }
        try {
            const plan = submenuFms.getPrimaryFlightPlan();
            const enrouteIcaos = [];
            for (const seg of plan.segmentsOfType(sdk.FlightPlanSegmentType.Enroute)) {
                for (let i = 0; i < seg.legs.length; i++) {
                    const legDef = seg.legs[i];
                    if (legDef && legDef.leg && isSelectableWaypointIcao(legDef.leg.fixIcao)) {
                        if (legDef.leg.fixIcao !== plan.originAirport && legDef.leg.fixIcao !== plan.destinationAirport) {
                            enrouteIcaos.push(legDef.leg.fixIcao);
                        }
                    }
                }
            }
            const orig = plan.originAirport || '';
            const dest = plan.destinationAirport || '';
            if (!orig && !dest && enrouteIcaos.length === 0) {
                return null;
            }
            const firstIdent = orig ? sdk.ICAO.getIdent(orig).trim() : (enrouteIcaos[0] ? sdk.ICAO.getIdent(enrouteIcaos[0]).trim() : '----');
            const lastIdent = dest ? sdk.ICAO.getIdent(dest).trim() : (enrouteIcaos.length > 0 ? sdk.ICAO.getIdent(enrouteIcaos[enrouteIcaos.length - 1]).trim() : '----');
            const record = {
                id: 'FPL-' + Date.now(),
                title: firstIdent + ' \u2192 ' + lastIdent,
                originIcao: orig,
                destIcao: dest,
                enrouteIcaos: enrouteIcaos,
                savedAt: Date.now()
            };
            const list = loadStoredFlightPlans();
            list.unshift(record);
            saveStoredFlightPlans(list);
            safeSetSimVar('L:CT182T_DBG_STORED_FPL_CNT', 'Number', list.length);
            return record;
        } catch (e) {
            return null;
        }
    }

    async function activateStoredFlightPlanRecord(record, invert) {
        if (!record || !submenuFms) {
            return false;
        }
        const loader = getFacilityLoader(null);
        if (!loader) {
            return false;
        }
        try {
            submenuFms.emptyPrimaryFlightPlan();
            const origIcao = invert ? record.destIcao : record.originIcao;
            const destIcao = invert ? record.originIcao : record.destIcao;
            const enrList = Array.isArray(record.enrouteIcaos) ? record.enrouteIcaos.slice() : [];
            if (invert) {
                enrList.reverse();
            }

            if (origIcao && isSelectableWaypointIcao(origIcao)) {
                const origFac = await loader.getFacility(sdk.ICAO.getFacilityType(origIcao), origIcao);
                if (origFac && 'bestApproach' in origFac) {
                    submenuFms.setOrigin(origFac);
                }
            }
            const plan = submenuFms.getPrimaryFlightPlan();
            const firstEnr = plan.segmentsOfType(sdk.FlightPlanSegmentType.Enroute).next().value;
            if (firstEnr) {
                for (let i = 0; i < enrList.length; i++) {
                    const ic = enrList[i];
                    if (isSelectableWaypointIcao(ic)) {
                        try {
                            const fac = await loader.getFacility(sdk.ICAO.getFacilityType(ic), ic);
                            if (fac) {
                                submenuFms.insertWaypoint(firstEnr.segmentIndex, fac);
                            }
                        } catch (e) {}
                    }
                }
            }
            if (destIcao && isSelectableWaypointIcao(destIcao)) {
                const destFac = await loader.getFacility(sdk.ICAO.getFacilityType(destIcao), destIcao);
                if (destFac && 'bestApproach' in destFac) {
                    submenuFms.setDestination(destFac);
                }
            }
            publishFlightPlanDiagnostics();
            return true;
        } catch (e) {
            return false;
        }
    }

    // --- Along-Track Offset Engine (Item #4 & Item #5) ---
    function getSelectedOrDestinationTargetForAtk() {
        if (!submenuFms || typeof submenuFms.hasPrimaryFlightPlan !== 'function' || !submenuFms.hasPrimaryFlightPlan()) {
            return null;
        }
        const plan = submenuFms.getPrimaryFlightPlan();
        let legDef = null;
        const mfdSel = mfdFplSelectedElement || lastMfdFplSelectedLeg;
        const fxCtrl = focusedFplFixCtrl || lastFocusedFplFixCtrl;
        if (isMfdContext && mfdSel && typeof mfdSel === 'object' && ('leg' in mfdSel)) {
            legDef = mfdSel;
        } else if (fxCtrl && fxCtrl.props && fxCtrl.props.data) {
            const d = fxCtrl.props.data;
            const unwrapped = (typeof d.get === 'function') ? d.get() : d;
            legDef = (unwrapped && unwrapped.legDefinition) ? unwrapped.legDefinition : ((unwrapped && unwrapped.leg && unwrapped.leg.leg) ? unwrapped.leg : unwrapped);
        }
        if (legDef) {
            const loc = resolveLegIndexesInPrimaryPlan(legDef);
            if (loc && legDef.leg && isSelectableWaypointIcao(legDef.leg.fixIcao)) {
                return { plan: plan, legDef: legDef, segmentIndex: loc.segmentIndex, segmentLegIndex: loc.segmentLegIndex, globalIndex: loc.globalIndex, fixIcao: legDef.leg.fixIcao };
            }
        }
        // Fallback: last leg / destination leg in Primary Flight Plan
        for (let g = plan.length - 1; g >= 0; g--) {
            const ld = plan.tryGetLeg(g);
            if (ld && ld.leg && isSelectableWaypointIcao(ld.leg.fixIcao)) {
                const sIdx = plan.getSegmentIndex(g);
                const seg = plan.tryGetSegment(sIdx);
                if (seg) {
                    return { plan: plan, legDef: ld, segmentIndex: sIdx, segmentLegIndex: seg.legs.indexOf(ld), globalIndex: g, fixIcao: ld.leg.fixIcao };
                }
            }
        }
        return null;
    }

    async function createAndInsertAtkOffsetWaypoint(targetInfo, offsetNm, altFeet) {
        if (!targetInfo || !submenuFms || !offsetNm || Math.abs(offsetNm) < 0.1) {
            return null;
        }
        const loader = getFacilityLoader(null);
        if (!loader) {
            return null;
        }
        try {
            const refFac = await loader.getFacility(sdk.ICAO.getFacilityType(targetInfo.fixIcao), targetInfo.fixIcao);
            if (!refFac || typeof refFac.lat !== 'number' || typeof refFac.lon !== 'number') {
                return null;
            }
            const plan = targetInfo.plan;
            let refLat = NaN;
            let refLon = NaN;
            let bearingTrue = NaN;

            if (offsetNm < 0) {
                // Prior to fix: step from refFac back toward preceding fix (or aircraft PPOS)
                for (let g = targetInfo.globalIndex - 1; g >= 0; g--) {
                    const prev = plan.tryGetLeg(g);
                    if (prev && prev.calculated && typeof prev.calculated.endLat === 'number' && !isNaN(prev.calculated.endLat)) {
                        refLat = prev.calculated.endLat;
                        refLon = prev.calculated.endLon;
                        break;
                    }
                    if (prev && prev.leg && isSelectableWaypointIcao(prev.leg.fixIcao)) {
                        try {
                            const pf = await loader.getFacility(sdk.ICAO.getFacilityType(prev.leg.fixIcao), prev.leg.fixIcao);
                            if (pf) { refLat = pf.lat; refLon = pf.lon; break; }
                        } catch (e) {}
                    }
                }
                if (isNaN(refLat)) {
                    const ppos = getPlaneCoordinates();
                    if (ppos) { refLat = ppos.lat; refLon = ppos.lon; }
                }
                bearingTrue = !isNaN(refLat) ? computeBearingDegTrue(refFac.lat, refFac.lon, refLat, refLon) : 180;
            } else {
                // Past fix: step toward next fix, or extend inbound track forward
                for (let g = targetInfo.globalIndex + 1; g < plan.length; g++) {
                    const nxt = plan.tryGetLeg(g);
                    if (nxt && nxt.leg && isSelectableWaypointIcao(nxt.leg.fixIcao)) {
                        try {
                            const nf = await loader.getFacility(sdk.ICAO.getFacilityType(nxt.leg.fixIcao), nxt.leg.fixIcao);
                            if (nf) { refLat = nf.lat; refLon = nf.lon; break; }
                        } catch (e) {}
                    }
                }
                if (!isNaN(refLat)) {
                    bearingTrue = computeBearingDegTrue(refFac.lat, refFac.lon, refLat, refLon);
                } else {
                    const ppos = getPlaneCoordinates();
                    bearingTrue = ppos ? computeBearingDegTrue(ppos.lat, ppos.lon, refFac.lat, refFac.lon) : 360;
                }
            }

            const pt = offsetLatLonByBearingDist(refFac.lat, refFac.lon, bearingTrue, Math.abs(offsetNm));
            const baseIdent = sdk.ICAO.getIdent(targetInfo.fixIcao).trim();
            const signCh = offsetNm < 0 ? '-' : '+';
            const absRounded = Math.round(Math.abs(offsetNm));
            const suffix = signCh + String(absRounded);
            const atkIdent = (baseIdent.substr(0, Math.max(1, 6 - suffix.length)) + suffix).substr(0, 6);
            const atkFac = registerUserFacilityInRepo(atkIdent, pt.lat, pt.lon, true, baseIdent + ' ' + signCh + Math.abs(offsetNm).toFixed(1) + 'NM');

            let insertSegIdx = targetInfo.segmentIndex;
            let insertLegIdx = offsetNm < 0 ? targetInfo.segmentLegIndex : (targetInfo.segmentLegIndex + 1);
            const seg = plan.tryGetSegment(insertSegIdx);
            if (seg && seg.segmentType === sdk.FlightPlanSegmentType.Destination && offsetNm < 0) {
                // Insert right at end of last Enroute segment if target is Destination airport
                insertSegIdx = submenuFms.findLastEnrouteSegmentIndex(plan);
                const enrSeg = plan.tryGetSegment(insertSegIdx);
                insertLegIdx = enrSeg ? enrSeg.legs.length : 0;
            }

            const ok = submenuFms.insertWaypoint(insertSegIdx, atkFac, insertLegIdx);
            if (ok && altFeet !== null && altFeet !== undefined && altFeet > 0 && typeof submenuFms.setUserConstraint === 'function') {
                const updatedSeg = plan.tryGetSegment(insertSegIdx);
                if (updatedSeg) {
                    const actualIdx = updatedSeg.legs.findIndex(function (l) { return l && l.leg && l.leg.fixIcao === atkFac.icao; });
                    if (actualIdx >= 0) {
                        submenuFms.setUserConstraint(insertSegIdx, actualIdx, altFeet);
                    }
                }
            }
            publishFlightPlanDiagnostics();
            return atkFac;
        } catch (e) {
            console.error('CT182TGfc700Plugin: createAndInsertAtkOffsetWaypoint error', e);
            return null;
        }
    }

    function updateAtkOffsetSoftkeyState(fplnMenu) {
        if (!fplnMenu || typeof fplnMenu.getItem !== 'function') {
            return;
        }
        const atkItem = fplnMenu.getItem(8);
        if (atkItem && atkItem.disabled) {
            const target = getSelectedOrDestinationTargetForAtk();
            atkItem.disabled.set(!target);
        }
    }

    // --- Shared G1000 Custom FMS Modal System (PFD & MFD) ---
    const customModalState = {
        isOpen: false,
        title: '',
        fields: [], // [{ label, getValueText, onSmallKnob, onClr }]
        focusedField: 0,
        footerText: 'Press "ENT" to accept  •  "CLR" to cancel',
        onAccept: null,
        domRoot: null
    };

    function ensureCustomModalDom() {
        if (typeof document === 'undefined' || !document.createElement) {
            return null;
        }
        if (document.head && !document.getElementById('wt-g1000-custom-modal-styles')) {
            const st = document.createElement('style');
            st.id = 'wt-g1000-custom-modal-styles';
            st.textContent = [
                '.highlight-select.cyan, .highlight-select .cyan, .highlight-select > span {',
                '  background-color: cyan; color: black !important;',
                '}',
                '.wt-fms-modal {',
                '  position: absolute; z-index: 950; right: 16px; bottom: 44px; width: 314px;',
                '  background: rgb(48, 48, 48); border: 4px solid rgb(150, 150, 150); border-radius: 10px;',
                '  box-shadow: 0 6px 20px rgba(0,0,0,0.92); font-family: Roboto, sans-serif; color: whitesmoke;',
                '  padding: 4px 6px 6px 6px; box-sizing: border-box; pointer-events: none;',
                '}',
                '.wt-fms-modal-title {',
                '  font-size: 16px; color: white; text-align: center;',
                '  border-bottom: 1px solid rgb(140, 140, 140); padding-bottom: 4px; margin-bottom: 6px;',
                '}',
                '.wt-fms-modal-box {',
                '  background: linear-gradient(to bottom, rgba(152,159,174,0.12) 0px, #000 10px);',
                '  border: 1px solid rgb(120, 120, 120); border-radius: 8px; padding: 6px 8px;',
                '}',
                '.wt-fms-modal-row {',
                '  display: flex; justify-content: space-between; align-items: center;',
                '  height: 26px; padding: 0 2px; font-size: 16px;',
                '}',
                '.wt-fms-modal-label { color: #c8cfd8; font-size: 14px; }',
                '.wt-fms-modal-val { color: cyan; padding: 1px 5px; min-width: 96px; text-align: right; }',
                '.wt-fms-modal-val.wt-focus { background: cyan; color: #000; font-weight: bold; }',
                '.wt-fms-modal-footer {',
                '  margin-top: 6px; font-size: 12px; color: #d8dee6; text-align: center;',
                '}',
                '.wt-map-ptr-banner {',
                '  position: absolute; z-index: 45; top: 62px; left: 160px;',
                '  background: rgba(8, 10, 14, 0.92); border: 1px solid cyan; border-radius: 4px;',
                '  padding: 3px 9px; font-family: Roboto, sans-serif; font-size: 14px; color: whitesmoke;',
                '  pointer-events: none; white-space: nowrap;',
                '}',
                '.wt-cum-sup { display: none; font-size: 11px; line-height: 11px; text-align: center; }',
                '.mfd-page.wt-fpl-cum-mode #dis .wt-cum-sup,',
                '.mfd-page.wt-fpl-cum-mode #wt-hdr-ete .wt-cum-sup { display: block; }',
                '.mfd-page.wt-fpl-cum-mode #dis,',
                '.mfd-page.wt-fpl-cum-mode #wt-hdr-ete { margin-top: -11px; line-height: 11px; text-align: center; }',
                '.wt-wide-hdr-cell { display: none; position: absolute; }',
                '.wt-hdr-stacked { margin-top: -11px; line-height: 11px; text-align: center; }',
                '.wt-hdr-stacked > span { display: block; font-size: 12px; }',
                '.wt-wide-cell { display: none !important; }',
                ':not(.active-wpt).fix-container > .wt-wide-cell { color: whitesmoke; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-hdr-cell { display: block; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-cell {',
                '  display: inline-block !important; overflow: hidden; white-space: nowrap; height: 26px; padding-bottom: 8px;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl.mfd-dark-background.wide {',
                '  left: 0px; right: 0px; width: 876px; top: 48px; height: 686px; padding-top: 348px;',
                '  background: transparent; box-sizing: border-box; overflow: hidden;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl.mfd-dark-background.wide::before {',
                '  content: ""; position: absolute; left: 440px; top: 344px; width: 436px; height: 342px;',
                '  background: rgb(50, 50, 50); border-left: 2px solid rgb(130, 136, 146); box-sizing: border-box; z-index: 0;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl > div:first-child {',
                '  position: absolute; left: 0px; top: 0px; width: 876px; height: 344px;',
                '  background: rgb(50, 50, 50); border-bottom: 2px solid rgb(130, 136, 146);',
                '  padding-top: 4px; box-sizing: border-box; z-index: 2;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl > div:nth-child(2) {',
                '  position: relative; z-index: 2; margin-left: 446px; margin-right: 5px; margin-top: 0px; width: 425px; box-sizing: border-box;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl > div:nth-child(3) {',
                '  position: relative; z-index: 2; margin-left: 446px; margin-right: 5px; margin-top: 6px; width: 425px; box-sizing: border-box;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-weather { height: 112px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-bottom-prompt {',
                '  z-index: 2; left: 440px; width: 436px; bottom: 6px;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #dtk { left: 218px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #dis { left: 306px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #alt { left: 405px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #wt-hdr-fuel { left: 525px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #wt-hdr-ete { left: 618px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #wt-hdr-eta { left: 726px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpl-plan-box #wt-hdr-brg { left: 808px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpln-container {',
                '  width: 850px !important; height: 224px !important;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fpln-container > .ui-control-list { height: 100%; }',
                '.mfd-page.wt-fpl-wide-mode .fix-container:not(.hidden-element) {',
                '  display: flex; align-items: center; width: 840px; height: 32px; line-height: 32px;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .fix-container > div:first-child { width: 185px; flex: 0 0 185px; overflow: hidden; }',
                '.mfd-page.wt-fpl-wide-mode .fix-name { width: 185px; padding-left: 25px; box-sizing: border-box; overflow: hidden; white-space: nowrap; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-dtk-value { width: 62px; flex: 0 0 62px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-dis-value { width: 92px; flex: 0 0 92px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-alt-value {',
                '  float: none !important; position: relative; width: 112px; flex: 0 0 112px;',
                '  text-align: right; padding-left: 4px; padding-right: 16px; box-sizing: border-box; overflow: visible; height: 26px;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-alt-value svg { right: -2px; top: 6px; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-fuel { width: 112px; flex: 0 0 112px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-ete { width: 86px; flex: 0 0 86px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-eta { width: 114px; flex: 0 0 114px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .wt-wide-brg { width: 74px; flex: 0 0 74px; text-align: right; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fplmap {',
                '  position: absolute !important; top: 392px !important; left: 0px !important; width: 440px; height: 342px; overflow: hidden;',
                '}',
                '.mfd-page.wt-fpl-wide-mode .mfd-fplmap .map-indicator-group-top-left { top: 2px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fplmap .map-minicompass { top: 26px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fplmap .map-pointerinfolayer-box { top: 2px; }',
                '.mfd-page.wt-fpl-wide-mode .mfd-fplmap .map-indicator-group-center { top: 155px; }',
                '.wt-custom-pane {',
                '  position: absolute; top: 48px; right: 0px; width: 436px; height: 686px;',
                '  background: rgb(50, 50, 50); color: whitesmoke; font-family: Roboto, sans-serif;',
                '  padding: 6px 5px 8px 5px; box-sizing: border-box; overflow: hidden;',
                '}',
                '.wt-custom-gbox {',
                '  position: relative; margin: 4px 2px 8px 2px; padding-top: 9px;',
                '}',
                '.wt-custom-gbox-title {',
                '  position: absolute; left: 14px; top: 0px; background: rgb(50, 50, 50);',
                '  color: white; font-size: 14px; padding: 0 4px; z-index: 5;',
                '}',
                '.wt-custom-gbox-body {',
                '  border-radius: 9px; border: 1px solid rgb(120, 120, 120);',
                '  background: linear-gradient(to bottom, rgba(152,159,174,0.1) 0px, #000 10px);',
                '  padding: 10px 8px 8px 8px; box-sizing: border-box;',
                '}',
                '.wt-custom-colhdr {',
                '  display: flex; justify-content: space-between; font-size: 13px; color: white;',
                '  border-bottom: 1px solid rgb(130, 136, 146); padding: 0 6px 3px 6px; margin-bottom: 4px;',
                '}',
                '.wt-custom-page-row {',
                '  display: flex; justify-content: space-between; align-items: center;',
                '  height: 26px; padding: 0 6px; font-size: 17px; color: cyan; white-space: nowrap; overflow: hidden;',
                '}',
                '.wt-custom-page-row > span:last-child { color: whitesmoke; }',
                '.wt-custom-page-row.wt-selected { background: cyan; color: #000 !important; font-weight: bold; }',
                '.wt-custom-page-row.wt-selected > span { color: #000 !important; }',
                '.wt-custom-info-line {',
                '  display: flex; justify-content: space-between; height: 24px; align-items: center;',
                '  font-size: 15px; padding: 0 4px; color: #c8cfd8;',
                '}',
                '.wt-custom-info-line > span:last-child { color: whitesmoke; }',
                '.wt-custom-prompt {',
                '  position: absolute; bottom: 8px; left: 0; width: 100%; text-align: center; font-size: 15px; color: white;',
                '}',
                '.wt-aux-fullpage {',
                '  position: absolute; left: 0px; top: 52px; width: 876px; height: 682px;',
                '  background: rgb(50, 50, 50); color: whitesmoke; font-family: Roboto, sans-serif;',
                '  padding: 6px 10px 6px 10px; box-sizing: border-box; overflow: hidden;',
                '}',
                '.wt-gps-top-grid {',
                '  display: grid; grid-template-columns: 272px 286px 282px; grid-gap: 0 8px; height: 372px;',
                '}',
                '.wt-gps-right-col { display: flex; flex-direction: column; justify-content: space-between; height: 372px; }',
                '.wt-aux-gbox { position: relative; padding-top: 9px; box-sizing: border-box; }',
                '.wt-aux-gbox-title {',
                '  position: absolute; left: 14px; top: 0px; background: rgb(50, 50, 50);',
                '  color: white; font-size: 14px; padding: 0 4px; z-index: 5; line-height: 15px;',
                '}',
                '.wt-aux-gbox-body {',
                '  border-radius: 9px; border: 1px solid rgb(125, 125, 125);',
                '  background: linear-gradient(to bottom, rgba(152,159,174,0.08) 0px, #000 10px);',
                '  padding: 9px 10px 8px 10px; box-sizing: border-box; height: 100%; overflow: hidden; position: relative;',
                '}',
                '.wt-gps-northup {',
                '  position: absolute; right: 8px; top: 7px; border: 1px solid rgb(135, 135, 135);',
                '  border-radius: 4px; padding: 1px 6px; font-size: 13px; color: white; background: #0a0d12;',
                '}',
                '.wt-gps-kv { display: flex; justify-content: space-between; align-items: center; height: 25px; font-size: 16px; }',
                '.wt-gps-kv > span:first-child { color: #b8c0cc; font-size: 14px; }',
                '.wt-gps-kv > span:last-child { color: whitesmoke; font-weight: bold; }',
                '.wt-gps-sep { border-top: 1px solid rgb(105, 110, 118); margin: 5px 0; }',
                '.wt-gps-edit { color: cyan !important; padding: 0 4px; border-radius: 2px; }',
                '.wt-gps-edit.wt-selected { background: cyan !important; color: #000 !important; }',
                '.wt-gps-raim-btn-wrap { display: flex; flex-direction: column; align-items: center; margin-top: 8px; }',
                '.wt-gps-raim-btn {',
                '  border: 1px solid rgb(150, 155, 165); border-radius: 5px; padding: 3px 14px;',
                '  font-size: 16px; color: white; background: #10141b; min-width: 156px; text-align: center;',
                '}',
                '.wt-gps-raim-btn.wt-selected { background: cyan !important; color: #000 !important; border-color: cyan; font-weight: bold; }',
                '.wt-gps-raim-status { margin-top: 6px; font-size: 16px; font-weight: bold; height: 20px; text-align: center; }',
                '.wt-gps-sbas-row {',
                '  display: flex; align-items: center; height: 30px; padding: 0 8px; font-size: 17px; color: cyan;',
                '}',
                '.wt-gps-sbas-row.wt-selected { background: cyan; color: #000 !important; font-weight: bold; }',
                '.wt-gps-sbas-chk {',
                '  display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;',
                '  border: 1px solid #9aa4b2; margin-right: 10px; font-size: 14px; color: #28e038; background: #05070a;',
                '}',
                '.wt-gps-sbas-row.wt-selected .wt-gps-sbas-chk { border-color: #000; background: #002226; color: #28e038; }',
                '.wt-sys-grid { display: grid; grid-template-columns: 468px 380px; grid-gap: 0 8px; height: 668px; }',
                '.wt-sys-right-col { display: flex; flex-direction: column; justify-content: space-between; height: 668px; }',
                '.wt-sys-lru-hdr {',
                '  display: grid; grid-template-columns: 118px 54px 158px 1fr; font-size: 13px; color: #cfd6e0;',
                '  border-bottom: 1px solid rgb(120, 126, 136); padding: 0 6px 4px 6px; margin-bottom: 4px;',
                '}',
                '.wt-sys-lru-row {',
                '  display: grid; grid-template-columns: 118px 54px 158px 1fr; align-items: center;',
                '  height: 31px; padding: 0 6px; font-size: 16px; color: whitesmoke;',
                '}',
                '.wt-sys-lru-row > span:first-child { color: #c8d0dc; font-size: 15px; }',
                '.wt-sys-lru-row.wt-selected { background: cyan; color: #000 !important; font-weight: bold; }',
                '.wt-sys-lru-row.wt-selected > span { color: #000 !important; }',
                '.wt-sys-ok { color: #28e038 !important; font-weight: bold; font-size: 18px; text-align: center; }',
                '.wt-sys-fail { color: #ff3b3b !important; font-weight: bold; font-size: 18px; text-align: center; }',
                '.wt-sys-lru-row.wt-selected .wt-sys-ok { color: #006b12 !important; }',
                '.wt-sys-db-item { padding: 4px 6px; border-bottom: 1px solid rgba(110,118,130,0.35); }',
                '.wt-sys-db-item.wt-selected { background: rgba(0, 255, 255, 0.22); outline: 1px solid cyan; }',
                '.wt-sys-db-title { font-size: 15px; color: white; font-weight: bold; margin-bottom: 2px; }',
                '.wt-sys-db-sub { display: flex; justify-content: space-between; font-size: 14px; color: #b8c0cc; height: 20px; align-items: center; }',
                '.wt-sys-db-sub > span:last-child { color: whitesmoke; }'
            ].join('\n');
            document.head.appendChild(st);
        }
        if (!customModalState.domRoot && document.body) {
            const root = document.createElement('div');
            root.className = 'wt-fms-modal';
            root.style.display = 'none';
            document.body.appendChild(root);
            customModalState.domRoot = root;
        }
        return customModalState.domRoot;
    }

    function renderCustomModalDom() {
        const root = ensureCustomModalDom();
        if (!root) return;
        if (!customModalState.isOpen) {
            root.style.display = 'none';
            return;
        }
        root.style.display = 'block';
        while (root.firstChild) root.removeChild(root.firstChild);

        const titleEl = document.createElement('div');
        titleEl.className = 'wt-fms-modal-title';
        titleEl.textContent = customModalState.title;
        root.appendChild(titleEl);

        const boxEl = document.createElement('div');
        boxEl.className = 'wt-fms-modal-box';
        for (let i = 0; i < customModalState.fields.length; i++) {
            const f = customModalState.fields[i];
            const row = document.createElement('div');
            row.className = 'wt-fms-modal-row';
            const lbl = document.createElement('span');
            lbl.className = 'wt-fms-modal-label';
            lbl.textContent = f.label;
            const val = document.createElement('span');
            val.className = 'wt-fms-modal-val' + (i === customModalState.focusedField ? ' wt-focus' : '');
            val.textContent = f.getValueText();
            row.appendChild(lbl);
            row.appendChild(val);
            boxEl.appendChild(row);
        }
        root.appendChild(boxEl);

        const ftr = document.createElement('div');
        ftr.className = 'wt-fms-modal-footer';
        ftr.textContent = customModalState.footerText;
        root.appendChild(ftr);

        try {
            if (typeof root.getBoundingClientRect === 'function') {
                const mr = root.getBoundingClientRect();
                const mok = (mr.width >= 280 && mr.top >= 40 && mr.bottom <= 740 && mr.right <= 1025) ? 1 : 0;
                safeSetSimVar('L:CT182T_DBG_MODAL_RECT_OK', 'Number', mok);
            }
        } catch (e) {}
    }

    function openCustomModal(config) {
        customModalState.isOpen = true;
        customModalState.title = config.title || '';
        customModalState.fields = config.fields || [];
        customModalState.focusedField = config.initialField || 0;
        customModalState.footerText = config.footerText || 'Press "ENT" to accept  •  "CLR" to cancel';
        customModalState.onAccept = config.onAccept || null;
        safeSetSimVar('L:CT182T_DBG_MODAL_OPEN', 'Number', 1);
        renderCustomModalDom();
    }

    function closeCustomModal() {
        customModalState.isOpen = false;
        customModalState.onAccept = null;
        safeSetSimVar('L:CT182T_DBG_MODAL_OPEN', 'Number', 0);
        renderCustomModalDom();
    }

    function handleCustomModalInteraction(evt, FmsHEvent) {
        if (!customModalState.isOpen || !FmsHEvent) {
            return false;
        }
        const fields = customModalState.fields;
        const cur = fields[customModalState.focusedField];
        if (evt === FmsHEvent.LOWER_INC) {
            if (customModalState.focusedField < fields.length - 1) {
                customModalState.focusedField++;
                renderCustomModalDom();
            }
            return true;
        }
        if (evt === FmsHEvent.LOWER_DEC) {
            if (customModalState.focusedField > 0) {
                customModalState.focusedField--;
                renderCustomModalDom();
            }
            return true;
        }
        if (evt === FmsHEvent.UPPER_INC) {
            if (cur && typeof cur.onSmallKnob === 'function') {
                cur.onSmallKnob(1);
                renderCustomModalDom();
            }
            return true;
        }
        if (evt === FmsHEvent.UPPER_DEC) {
            if (cur && typeof cur.onSmallKnob === 'function') {
                cur.onSmallKnob(-1);
                renderCustomModalDom();
            }
            return true;
        }
        if (evt === FmsHEvent.CLR) {
            if (cur && typeof cur.onClr === 'function' && cur.onClr()) {
                renderCustomModalDom();
                return true;
            }
            closeCustomModal();
            return true;
        }
        if (evt === FmsHEvent.UPPER_PUSH) {
            closeCustomModal();
            return true;
        }
        if (evt === FmsHEvent.ENT) {
            const cb = customModalState.onAccept;
            closeCustomModal();
            if (typeof cb === 'function') {
                cb();
            }
            return true;
        }
        return false;
    }

    // --- Modal Launchers for ATK Offset (#4), User WPT (#11), Temp Comp (#15), Closest Point (#16) ---
    function openAtkOffsetDialog() {
        const target = getSelectedOrDestinationTargetForAtk();
        if (!target) return;
        const refIdent = sdk.ICAO.getIdent(target.fixIcao).trim();
        let distNm = -5.0;
        let altFeet = 0; // 0 = unset
        openCustomModal({
            title: 'Create ATK Offset (' + refIdent + ')',
            fields: [
                {
                    label: 'Reference WPT',
                    getValueText: function () { return refIdent; }
                },
                {
                    label: 'Along-Track Offset',
                    getValueText: function () { return (distNm >= 0 ? '+' : '') + distNm.toFixed(1) + ' NM'; },
                    onSmallKnob: function (dir) {
                        distNm = Math.max(-99, Math.min(99, distNm + dir * 1.0));
                        if (Math.abs(distNm) < 0.5) distNm = dir > 0 ? 1.0 : -1.0;
                    }
                },
                {
                    label: 'VNV Target Alt',
                    getValueText: function () { return altFeet > 0 ? (altFeet + ' FT') : '----- FT'; },
                    onSmallKnob: function (dir) {
                        if (altFeet <= 0) {
                            let curAlt = 2000;
                            try {
                                const ia = Number(SimVar.GetSimVarValue('INDICATED ALTITUDE', 'feet'));
                                if (!isNaN(ia) && ia > 200) curAlt = Math.max(500, Math.round(ia / 500) * 500);
                            } catch (e) {}
                            altFeet = curAlt;
                        } else {
                            altFeet = Math.max(100, Math.min(45000, altFeet + dir * 100));
                        }
                    },
                    onClr: function () {
                        if (altFeet > 0) { altFeet = 0; return true; }
                        return false;
                    }
                }
            ],
            initialField: 1,
            onAccept: function () {
                createAndInsertAtkOffsetWaypoint(target, distNm, altFeet > 0 ? altFeet : undefined);
            }
        });
    }

    function openCreateUserWaypointDialog() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const existing = loadStoredUserWaypoints();
        const nextNum = String(existing.length + 1).padStart(2, '0');
        let identArr = ('USR' + nextNum + ' ').substr(0, 5).trim().split('');
        while (identArr.length < 5) identArr.push('0');
        let charIdx = 3;
        const ppos = getPlaneCoordinates() || { lat: 47.906, lon: -122.281 };
        let mode = 0; // 0 = PPOS / LatLon, 1 = RAD / DIS from nearest/FPL ref
        let refEntry = null;
        for (const v of facilityDirectory.values()) {
            if (v.facType === sdk.FacilityType.VOR || v.facType === sdk.FacilityType.Airport) {
                refEntry = v;
                break;
            }
        }
        let radialDeg = 360;
        let distNm = 5.0;
        let latVal = ppos.lat;
        let lonVal = ppos.lon;

        openCustomModal({
            title: 'Create User Waypoint',
            fields: [
                {
                    label: 'Ident (Char ' + (charIdx + 1) + ')',
                    getValueText: function () { return identArr.join(''); },
                    onSmallKnob: function (dir) {
                        const cur = identArr[charIdx] || 'A';
                        const nextPos = (chars.indexOf(cur) + dir + chars.length) % chars.length;
                        identArr[charIdx] = chars[nextPos];
                    },
                    onClr: function () {
                        charIdx = (charIdx + 1) % identArr.length;
                        this.label = 'Ident (Char ' + (charIdx + 1) + ')';
                        return true;
                    }
                },
                {
                    label: 'Type',
                    getValueText: function () { return mode === 0 ? 'PPOS / LAT-LON' : ('RAD/DIS (' + (refEntry ? refEntry.ident : 'PPOS') + ')'); },
                    onSmallKnob: function () { mode = mode === 0 ? 1 : 0; }
                },
                {
                    label: 'Brg / Lat Δ',
                    getValueText: function () { return mode === 0 ? latVal.toFixed(4) + '\u00B0' : (String(radialDeg).padStart(3, '0') + '\u00B0'); },
                    onSmallKnob: function (dir) {
                        if (mode === 0) latVal = Math.max(-89.9, Math.min(89.9, latVal + dir * 0.01));
                        else { radialDeg = ((radialDeg - 1 + dir + 360) % 360) + 1; }
                    }
                },
                {
                    label: 'Dis / Lon Δ',
                    getValueText: function () { return mode === 0 ? lonVal.toFixed(4) + '\u00B0' : (distNm.toFixed(1) + ' NM'); },
                    onSmallKnob: function (dir) {
                        if (mode === 0) lonVal = Math.max(-179.9, Math.min(179.9, lonVal + dir * 0.01));
                        else distNm = Math.max(0.5, Math.min(199.0, distNm + dir * 0.5));
                    }
                }
            ],
            initialField: 0,
            footerText: 'ENT: Save User WPT • CLR on Ident: Next Char',
            onAccept: function () {
                let finalLat = latVal;
                let finalLon = lonVal;
                if (mode === 1 && refEntry && !isNaN(refEntry.lat)) {
                    const pt = offsetLatLonByBearingDist(refEntry.lat, refEntry.lon, radialDeg, distNm);
                    finalLat = pt.lat;
                    finalLon = pt.lon;
                }
                addPersistedUserWaypoint(identArr.join('').trim(), finalLat, finalLon, 'USER WAYPOINT');
            }
        });
    }

    function openTempCompDialog() {
        let oatC = -10;
        try {
            const amb = Number(SimVar.GetSimVarValue('AMBIENT TEMPERATURE', 'celsius'));
            if (!isNaN(amb)) oatC = Math.round(amb);
        } catch (e) {}
        let fieldElevFt = 200;
        if (submenuFms && submenuFms.hasPrimaryFlightPlan()) {
            const plan = submenuFms.getPrimaryFlightPlan();
            if (plan.destinationAirport && facilityDirectory.has(plan.destinationAirport)) {
                const df = facilityDirectory.get(plan.destinationAirport);
                if (df && df.runways && df.runways.length > 0 && typeof df.runways[0].elevation === 'number') {
                    fieldElevFt = Math.round(df.runways[0].elevation * 3.28084);
                }
            }
        }
        const computeCompAlt = function (rawAltFt) {
            const hAbove = Math.max(0, rawAltFt - fieldElevFt);
            const isaTemp = 15 - 0.00198 * fieldElevFt;
            if (oatC >= isaTemp) return rawAltFt;
            // ICAO Doc 8168 Cold Temp Correction formula
            const delta = hAbove * ((15 - oatC) / (273 + oatC - 0.5 * 0.00198 * (rawAltFt + fieldElevFt)) - 0.00198 * hAbove / 288);
            const simpleIcao = hAbove * ((isaTemp - oatC) / (273 + oatC));
            const corr = Math.max(0, isNaN(delta) ? simpleIcao : simpleIcao);
            return Math.ceil((rawAltFt + corr) / 10) * 10;
        };

        openCustomModal({
            title: 'Temperature Compensation',
            fields: [
                {
                    label: 'Dest Airport Temp',
                    getValueText: function () { return (oatC >= 0 ? '+' : '') + oatC + ' \u00B0C'; },
                    onSmallKnob: function (dir) { oatC = Math.max(-55, Math.min(30, oatC + dir)); }
                },
                {
                    label: 'Airport Elev',
                    getValueText: function () { return fieldElevFt + ' FT'; },
                    onSmallKnob: function (dir) { fieldElevFt = Math.max(0, Math.min(14000, fieldElevFt + dir * 50)); }
                },
                {
                    label: '2000 FT FAF \u2192 Comp',
                    getValueText: function () { return computeCompAlt(fieldElevFt + 1800) + ' FT'; }
                }
            ],
            initialField: 0,
            footerText: 'ENT: Apply Cold-Temp Comp to Approach',
            onAccept: function () {
                if (!submenuFms || !submenuFms.hasPrimaryFlightPlan()) return;
                const plan = submenuFms.getPrimaryFlightPlan();
                for (const seg of plan.segmentsOfType(sdk.FlightPlanSegmentType.Approach)) {
                    for (let i = 0; i < seg.legs.length; i++) {
                        const ld = seg.legs[i];
                        if (ld && ld.leg && ld.leg.altitude1 > 0) {
                            const rawFt = Math.round(ld.leg.altitude1 * 3.28084);
                            const compFt = computeCompAlt(rawFt);
                            if (compFt > rawFt && typeof submenuFms.setUserConstraint === 'function') {
                                submenuFms.setUserConstraint(seg.segmentIndex, i, compFt);
                            }
                        }
                    }
                }
            }
        });
    }

    function openClosestPointOfFplDialog() {
        const candidates = Array.from(facilityDirectory.values()).filter(function (f) { return !isNaN(f.lat) && !isNaN(f.lon); });
        if (candidates.length === 0) return;
        let selIdx = 0;
        const computeClosest = function () {
            const ref = candidates[selIdx];
            if (!ref || !submenuFms || !submenuFms.hasPrimaryFlightPlan()) {
                return { brg: '---', dis: '--.- NM' };
            }
            const plan = submenuFms.getPrimaryFlightPlan();
            let bestDistNm = Infinity;
            let bestBrg = 0;
            for (const ld of plan.legs()) {
                if (ld && ld.calculated && typeof ld.calculated.endLat === 'number' && !isNaN(ld.calculated.endLat)) {
                    const dNm = computeDistanceRad(ref.lat, ref.lon, ld.calculated.endLat, ld.calculated.endLon) * (180 / Math.PI) * 60;
                    if (dNm < bestDistNm) {
                        bestDistNm = dNm;
                        bestBrg = Math.round(computeBearingDegTrue(ref.lat, ref.lon, ld.calculated.endLat, ld.calculated.endLon));
                    }
                }
            }
            if (!isFinite(bestDistNm)) return { brg: '---', dis: '--.- NM' };
            return { brg: String(bestBrg === 0 ? 360 : bestBrg).padStart(3, '0') + '\u00B0', dis: bestDistNm.toFixed(1) + ' NM' };
        };

        openCustomModal({
            title: 'Closest Point Of FPL',
            fields: [
                {
                    label: 'Reference WPT',
                    getValueText: function () { return candidates[selIdx] ? candidates[selIdx].ident : '----'; },
                    onSmallKnob: function (dir) { selIdx = (selIdx + dir + candidates.length) % candidates.length; }
                },
                {
                    label: 'Bearing To FPL',
                    getValueText: function () { return computeClosest().brg; }
                },
                {
                    label: 'Min Distance',
                    getValueText: function () { return computeClosest().dis; }
                }
            ],
            initialField: 0,
            footerText: 'Small Knob: Select Reference WPT • ENT/CLR: Close'
        });
    }

    function enhanceMediumMenuItems(it) {
        if (!it || !it.id) return;
        if (it.id === 'create-atk') {
            it.isEnabled = !!getSelectedOrDestinationTargetForAtk();
            it.action = function () { openAtkOffsetDialog(); };
        } else if (it.id === 'store-fpln') {
            it.isEnabled = !!(submenuFms && submenuFms.hasPrimaryFlightPlan && submenuFms.hasPrimaryFlightPlan() && (submenuFms.getPrimaryFlightPlan().length > 0 || submenuFms.getPrimaryFlightPlan().originAirport));
            it.action = function () {
                const rec = storeCurrentPrimaryFlightPlan();
                if (rec && submenuViewService) {
                    submenuViewService.open('MessageDialog', true).setInput({ inputString: 'Stored Flight Plan: ' + rec.title });
                }
            };
        } else if (it.id === 'usr-wpt') {
            it.isEnabled = true;
            it.action = function () { openCreateUserWaypointDialog(); };
        } else if (it.id === 'temp-comp') {
            it.isEnabled = !!(submenuFms && submenuFms.hasPrimaryFlightPlan && submenuFms.hasPrimaryFlightPlan());
            it.action = function () { openTempCompDialog(); };
        } else if (it.id === 'closest-point') {
            it.isEnabled = facilityDirectory.size > 0 || !!(submenuFms && submenuFms.hasPrimaryFlightPlan && submenuFms.hasPrimaryFlightPlan() && submenuFms.getPrimaryFlightPlan().length > 0);
            it.action = function () { openClosestPointOfFplDialog(); };
        }
    }

    // --- Item #9: MFD Wide / Narrow FPL View & CUM / Leg-Leg ---
    let mfdWideFplEnabled = false;
    let mfdWideCumMode = false;
    let mfdFplPageInstance = null;
    let mfdFplDetailsInstance = null;
    const mfdScrollBars = [];
    let wideFplTickTimer = null;

    function refreshMfdScrollBars() {
        for (let i = 0; i < mfdScrollBars.length; i++) {
            const sb = mfdScrollBars[i];
            if (sb && typeof sb.adjustScrollbarDimensions === 'function') {
                try {
                    sb.currentScrollHeight = -1;
                    sb.adjustScrollbarDimensions();
                } catch (e) {}
            }
        }
    }

    function ensureWideFplHeaders(detailsInst) {
        if (!detailsInst || !detailsInst.fplDetailsContainer || !detailsInst.fplDetailsContainer.instance) return;
        const rootEl = detailsInst.fplDetailsContainer.instance;
        const disHdr = rootEl.querySelector('#dis');
        if (!disHdr || !disHdr.parentElement) return;
        if (!disHdr.querySelector('.wt-cum-sup')) {
            const sup = document.createElement('span');
            sup.className = 'wt-cum-sup';
            sup.textContent = 'CUM';
            disHdr.insertBefore(sup, disHdr.firstChild);
        }
        const hdrRow = disHdr.parentElement;
        if (!hdrRow.querySelector('#wt-hdr-fuel')) {
            const fEl = document.createElement('span');
            fEl.id = 'wt-hdr-fuel';
            fEl.className = 'smallText white wt-wide-hdr-cell wt-hdr-stacked';
            fEl.innerHTML = '<span>FUEL</span><span>REM</span>';
            hdrRow.appendChild(fEl);

            const eteEl = document.createElement('span');
            eteEl.id = 'wt-hdr-ete';
            eteEl.className = 'smallText white wt-wide-hdr-cell';
            eteEl.innerHTML = '<span class="wt-cum-sup">CUM</span>ETE';
            hdrRow.appendChild(eteEl);

            const etaEl = document.createElement('span');
            etaEl.id = 'wt-hdr-eta';
            etaEl.className = 'smallText white wt-wide-hdr-cell';
            etaEl.textContent = 'ETA';
            hdrRow.appendChild(etaEl);

            const brgEl = document.createElement('span');
            brgEl.id = 'wt-hdr-brg';
            brgEl.className = 'smallText white wt-wide-hdr-cell';
            brgEl.textContent = 'BRG';
            hdrRow.appendChild(brgEl);
        }
    }

    function formatGarminEte(sec) {
        if (!isFinite(sec) || sec < 0 || sec >= 359940) return '__:__';
        if (sec < 3600) {
            const mm = Math.floor(sec / 60);
            const ss = Math.floor(sec % 60);
            return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
        }
        const hh = Math.floor(sec / 3600);
        const mm = Math.floor((sec % 3600) / 60);
        return String(hh).padStart(2, '0') + '+' + String(mm).padStart(2, '0');
    }

    function formatGarminEta(cumSec) {
        if (!isFinite(cumSec) || cumSec < 0 || cumSec >= 359940) return '__:__';
        let useUtc = true;
        let is12Hr = false;
        let offsetMs = 0;
        const gsdk = window.garminsdk;
        try {
            if (gsdk && gsdk.DateTimeUserSettings && submenuBus) {
                const dtMgr = gsdk.DateTimeUserSettings.getManager(submenuBus);
                const fmt = dtMgr.getSetting('dateTimeFormat').value;
                const FMode = gsdk.DateTimeFormatSettingMode || {};
                if (fmt === FMode.Local24) {
                    useUtc = false;
                } else if (fmt === FMode.Local12) {
                    useUtc = false;
                    is12Hr = true;
                }
                offsetMs = Number(dtMgr.getSetting('dateTimeLocalOffset').value) || 0;
            }
        } catch (e) {}

        let baseSec = 0;
        try {
            if (typeof SimVar !== 'undefined') {
                if (useUtc) {
                    baseSec = Number(SimVar.GetSimVarValue('E:ZULU TIME', 'seconds')) || 0;
                } else if (offsetMs !== 0) {
                    baseSec = (Number(SimVar.GetSimVarValue('E:ZULU TIME', 'seconds')) || 0) + (offsetMs / 1000);
                } else {
                    baseSec = Number(SimVar.GetSimVarValue('E:LOCAL TIME', 'seconds')) || 0;
                }
            }
        } catch (e) {}

        let totalMin = Math.floor((((baseSec + cumSec) % 86400) + 86400) % 86400 / 60);
        let hh = Math.floor(totalMin / 60) % 24;
        const mm = totalMin % 60;
        if (is12Hr) {
            hh = hh % 12;
            if (hh === 0) hh = 12;
        }
        const suffix = useUtc ? 'UTC' : 'LCL';
        return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + '<span class="smallText">' + suffix + '</span>';
    }

    function getLegDistanceMeters(sec, legInfo) {
        if (!legInfo || !legInfo.legDefinition) return 0;
        const ld = legInfo.legDefinition;
        if (legInfo.isActive && sec && typeof sec.getActiveLegDistance === 'function') {
            const actM = Number(sec.getActiveLegDistance()) || 0;
            if (actM > 0.1) return actM;
        }
        if (legInfo.isAirwayExitFix && legInfo.isCollapsed) {
            return Number(legInfo.airwayDistance) || 0;
        }
        if (isHoldLegType(ld.leg.type)) {
            const fp = ld.calculated && ld.calculated.flightPath;
            if (fp && fp.length > 0) {
                return Number(fp[fp.length - 1].distance) || 0;
            }
            return 0;
        }
        return (ld.calculated && ld.calculated.distance) ? Number(ld.calculated.distance) : 0;
    }

    function ensureFixWideCells(fixEl) {
        if (!fixEl) return null;
        let cells = fixEl._wtWideCells;
        if (!cells) {
            const fuel = document.createElement('div');
            fuel.className = 'wt-wide-cell wt-wide-fuel';
            const ete = document.createElement('div');
            ete.className = 'wt-wide-cell wt-wide-ete';
            const eta = document.createElement('div');
            eta.className = 'wt-wide-cell wt-wide-eta';
            const brg = document.createElement('div');
            brg.className = 'wt-wide-cell wt-wide-brg';
            fixEl.appendChild(fuel);
            fixEl.appendChild(ete);
            fixEl.appendChild(eta);
            fixEl.appendChild(brg);
            cells = { fuel: fuel, ete: ete, eta: eta, brg: brg };
            fixEl._wtWideCells = cells;
        }
        return cells;
    }

    function refreshWideFplPanel() {
        if (!isMfdContext || typeof document === 'undefined') return;
        ensureCustomModalDom();

        if (mfdFplPageInstance && mfdFplPageInstance.viewContainerRef && mfdFplPageInstance.viewContainerRef.instance) {
            const pageEl = mfdFplPageInstance.viewContainerRef.instance;
            pageEl.classList.toggle('wt-fpl-wide-mode', !!mfdWideFplEnabled);
            pageEl.classList.toggle('wt-fpl-cum-mode', !!mfdWideCumMode);

            if (mfdFplPageInstance.compiledMap && mfdFplPageInstance.compiledMap.context && mfdFplPageInstance._wtAppliedWideMap !== mfdWideFplEnabled) {
                mfdFplPageInstance._wtAppliedWideMap = mfdWideFplEnabled;
                try {
                    const ctx = mfdFplPageInstance.compiledMap.context;
                    if (mfdWideFplEnabled) {
                        if (ctx.deadZone && typeof ctx.deadZone.set === 'function') ctx.deadZone.set(0, 0, 0, 0);
                        if (ctx.projectedSize && typeof ctx.projectedSize.set === 'function') ctx.projectedSize.set(new Float64Array([440, 342]));
                    } else {
                        if (ctx.deadZone && typeof ctx.deadZone.set === 'function') ctx.deadZone.set(0, 56, 0, 0);
                        if (ctx.projectedSize && typeof ctx.projectedSize.set === 'function') ctx.projectedSize.set(new Float64Array([440, 734]));
                    }
                } catch (e) {}
                setTimeout(function () {
                    refreshMfdScrollBars();
                    try {
                        if (mfdFplPageInstance && mfdFplPageInstance.fplRef && mfdFplPageInstance.fplRef.instance) {
                            mfdFplPageInstance.fplRef.instance.scrollToActiveLeg(false);
                        }
                    } catch (e) {}
                }, 30);
            }
        }

        if (!mfdFplDetailsInstance) return;
        ensureWideFplHeaders(mfdFplDetailsInstance);

        if (submenuViewService && submenuViewService.openPageKey.get() !== 'FPLPage') {
            return;
        }

        const secList = mfdFplDetailsInstance.sectionListRef && mfdFplDetailsInstance.sectionListRef.instance;
        if (!secList || typeof secList.getChildInstance !== 'function') return;

        let pposLat = NaN;
        let pposLon = NaN;
        let gsKts = 0;
        let ffGph = 0;
        let fuelNowGal = 0;
        let magVarDeg = 0;
        try {
            if (typeof SimVar !== 'undefined') {
                pposLat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees'));
                pposLon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees'));
                gsKts = Number(SimVar.GetSimVarValue('GPS GROUND SPEED', 'knots')) || 0;
                ffGph = Number(SimVar.GetSimVarValue('ENG FUEL FLOW GPH:1', 'gallons per hour')) || 0;
                const rawFuel = Number(SimVar.GetSimVarValue('FUEL TOTAL QUANTITY', 'gallons')) || 0;
                const wtRem = Number(SimVar.GetSimVarValue('L:WT1000_Fuel_GalRemaining', 'gallons'));
                fuelNowGal = (!isNaN(wtRem) && (wtRem > 0.05 || rawFuel <= 0.5)) ? wtRem : rawFuel;
                magVarDeg = Number(SimVar.GetSimVarValue('MAGVAR', 'degrees')) || 0;
            }
        } catch (e) {}

        let anyActive = false;
        for (let s = 0; s < secList.length; s++) {
            const sec = secList.getChildInstance(s);
            const legList = sec && sec.getListRef && sec.getListRef().instance;
            if (!legList) continue;
            for (let l = 0; l < legList.length; l++) {
                const fc = legList.getChildInstance(l);
                const li = fc && fc.props && fc.props.data && fc.props.data.get();
                if (li && li.isActive) {
                    anyActive = true;
                    break;
                }
            }
            if (anyActive) break;
        }

        let accumulating = false;
        let cumMeters = 0;
        let rowOrderIdx = 0;
        let firstActiveCells = null;
        let firstActiveFixEl = null;

        for (let s = 0; s < secList.length; s++) {
            const sec = secList.getChildInstance(s);
            const legList = sec && sec.getListRef && sec.getListRef().instance;
            if (!legList) continue;
            for (let l = 0; l < legList.length; l++) {
                const fixComp = legList.getChildInstance(l);
                if (!fixComp || !fixComp.props || !fixComp.props.data) continue;
                const legInfo = fixComp.props.data.get();
                const fixEl = fixComp.fixEl && fixComp.fixEl.instance;
                if (!legInfo || !legInfo.legDefinition || !fixEl) continue;

                const ld = legInfo.legDefinition;
                const legMeters = getLegDistanceMeters(sec, legInfo);
                const isPassedOrOrigin = !!legInfo.legIsBehind
                    || (!legInfo.isActive && !accumulating && (anyActive || (rowOrderIdx === 0 && legMeters < 0.1)));

                if (!isPassedOrOrigin) {
                    accumulating = true;
                }

                const rowCumMeters = isPassedOrOrigin ? -1 : (cumMeters + legMeters);
                if (!isPassedOrOrigin && !isHoldLegType(ld.leg.type)) {
                    cumMeters += legMeters;
                }

                fixComp._wtCumMeters = rowCumMeters;
                if (!fixComp._wtOrigSetDistance && typeof fixComp.setDistance === 'function') {
                    fixComp._wtOrigSetDistance = fixComp.setDistance;
                    fixComp.setDistance = function (legArg) {
                        if (mfdWideCumMode && typeof this._wtCumMeters === 'number') {
                            this._distance.set(this._wtCumMeters);
                        } else {
                            this._wtOrigSetDistance.call(this, legArg);
                        }
                    };
                }
                if (mfdWideCumMode || fixComp._wtWasCumMode) {
                    fixComp._wtWasCumMode = mfdWideCumMode;
                    fixComp.setDistance(legInfo);
                }

                const cells = ensureFixWideCells(fixEl);
                if (cells) {
                    if (isPassedOrOrigin) {
                        cells.fuel.innerHTML = '';
                        cells.ete.innerHTML = '';
                        cells.eta.innerHTML = '';
                        cells.brg.innerHTML = '';
                    } else {
                        // BRG from present position to waypoint
                        let wptLat = (ld.calculated && typeof ld.calculated.endLat === 'number') ? ld.calculated.endLat : NaN;
                        let wptLon = (ld.calculated && typeof ld.calculated.endLon === 'number') ? ld.calculated.endLon : NaN;
                        if ((isNaN(wptLat) || isNaN(wptLon)) && ld.leg && ld.leg.fixIcao) {
                            const dirEntry = facilityDirectory.get(ld.leg.fixIcao);
                            if (dirEntry) {
                                wptLat = dirEntry.lat;
                                wptLon = dirEntry.lon;
                            }
                        }
                        if (!isNaN(pposLat) && !isNaN(pposLon) && !isNaN(wptLat) && !isNaN(wptLon)) {
                            const trueBrg = computeBearingDegTrue(pposLat, pposLon, wptLat, wptLon);
                            const magBrg = (sdk && sdk.MagVar && typeof sdk.MagVar.trueToMagnetic === 'function')
                                ? sdk.MagVar.trueToMagnetic(trueBrg, pposLat, pposLon)
                                : ((trueBrg - magVarDeg + 360) % 360);
                            let brgInt = Math.round(magBrg) % 360;
                            if (brgInt <= 0) brgInt = 360;
                            cells.brg.innerHTML = String(brgInt).padStart(3, '0') + '\u00B0';
                        } else {
                            cells.brg.innerHTML = '___\u00B0';
                        }

                        if (gsKts >= 30 && legMeters >= 0.1) {
                            const eteMeters = mfdWideCumMode ? rowCumMeters : legMeters;
                            const eteSec = ((eteMeters / 1852) / gsKts) * 3600;
                            const cumSec = ((rowCumMeters / 1852) / gsKts) * 3600;
                            cells.ete.innerHTML = formatGarminEte(eteSec);
                            cells.eta.innerHTML = formatGarminEta(cumSec);
                            if (ffGph > 0.1) {
                                const remGal = fuelNowGal - (cumSec / 3600) * ffGph;
                                const remStr = Math.abs(remGal) < 100 ? remGal.toFixed(1) : String(Math.round(remGal));
                                cells.fuel.innerHTML = remStr + '<span class="smallText">GAL</span>';
                            } else {
                                cells.fuel.innerHTML = '___<span class="smallText">GAL</span>';
                            }
                        } else {
                            cells.fuel.innerHTML = '___<span class="smallText">GAL</span>';
                            cells.ete.innerHTML = '__:__';
                            cells.eta.innerHTML = '__:__';
                        }

                        if (!firstActiveCells) {
                            firstActiveCells = cells;
                            firstActiveFixEl = fixEl;
                        }
                    }
                }
                rowOrderIdx++;
            }
        }

        // Publish DOM bounding-box telemetry for live SimConnect layout verification
        try {
            if (mfdWideFplEnabled && mfdFplPageInstance && mfdFplPageInstance.viewContainerRef && mfdFplPageInstance.viewContainerRef.instance) {
                const pageEl = mfdFplPageInstance.viewContainerRef.instance;
                const planBox = pageEl.querySelector('.mfd-fpl-plan-box');
                const mapEl = pageEl.querySelector('.mfd-fplmap');
                const fplEl = pageEl.querySelector('.mfd-fpl');
                const vnvBox = fplEl && fplEl.children && fplEl.children[1];
                const wxBox = fplEl && fplEl.children && fplEl.children[2];
                if (planBox && mapEl && vnvBox && typeof planBox.getBoundingClientRect === 'function') {
                    const pr = planBox.getBoundingClientRect();
                    const mr = mapEl.getBoundingClientRect();
                    const vr = vnvBox.getBoundingClientRect();
                    const wr = wxBox ? wxBox.getBoundingClientRect() : vr;
                    safeSetSimVar('L:CT182T_DBG_WIDE_PLAN_TOP', 'Number', Math.round(pr.top));
                    safeSetSimVar('L:CT182T_DBG_WIDE_PLAN_W', 'Number', Math.round(pr.width));
                    safeSetSimVar('L:CT182T_DBG_WIDE_MAP_TOP', 'Number', Math.round(mr.top));
                    safeSetSimVar('L:CT182T_DBG_WIDE_MAP_H', 'Number', Math.round(mr.height));
                    safeSetSimVar('L:CT182T_DBG_WIDE_VNV_LEFT', 'Number', Math.round(vr.left));
                    safeSetSimVar('L:CT182T_DBG_WIDE_VNV_TOP', 'Number', Math.round(vr.top));
                    safeSetSimVar('L:CT182T_DBG_WIDE_WX_BOT', 'Number', Math.round(wr.bottom));
                    if (firstActiveFixEl && firstActiveCells) {
                        const altEl = firstActiveFixEl.querySelector('.mfd-alt-value');
                        const ar = altEl ? altEl.getBoundingClientRect() : null;
                        const fr = firstActiveCells.fuel.getBoundingClientRect();
                        const br = firstActiveCells.brg.getBoundingClientRect();
                        const colsOk = (ar && fr.width > 50 && br.width > 40 && ar.right <= fr.left + 4 && br.right <= pr.right) ? 1 : 0;
                        safeSetSimVar('L:CT182T_DBG_WIDE_COLS_OK', 'Number', colsOk);
                    }
                }
            }
        } catch (e) {}
    }

    function installMediumSoftkeyHooks(menuSys) {
        if (!isMfdContext || !menuSys) return;
        const mfdMod = window.g1000nximfd;
        if (!mfdMod || !mfdMod.SoftKeyMenu) return;

        const fplnMenu = typeof menuSys.getMenu === 'function' ? menuSys.getMenu('fpln-menu') : menuSys.registeredMenus['fpln-menu'];
        if (fplnMenu && typeof fplnMenu.getItem === 'function') {
            // Item #11: Enable 'New WPT' softkey (index 3)
            const newWptItem = fplnMenu.getItem(3);
            if (newWptItem) {
                newWptItem.handler = function () { openCreateUserWaypointDialog(); };
                if (newWptItem.disabled) newWptItem.disabled.set(false);
            }

            // Item #4: Enable 'ATK OFS' softkey (index 8)
            const atkItem = fplnMenu.getItem(8);
            if (atkItem) {
                atkItem.handler = function () { openAtkOffsetDialog(); };
                updateAtkOffsetSoftkeyState(fplnMenu);
            }

            // Item #9: Enable 'View' softkey (index 4) & register 'view-opt'
            const viewMenu = new mfdMod.SoftKeyMenu(menuSys);
            const syncViewIndicators = function () {
                if (viewMenu.getItem(4) && viewMenu.getItem(4).value) viewMenu.getItem(4).value.set(mfdWideFplEnabled);
                if (viewMenu.getItem(5) && viewMenu.getItem(5).value) viewMenu.getItem(5).value.set(!mfdWideFplEnabled);
                if (viewMenu.getItem(7) && viewMenu.getItem(7).value) viewMenu.getItem(7).value.set(!mfdWideCumMode);
                if (viewMenu.getItem(8) && viewMenu.getItem(8).value) viewMenu.getItem(8).value.set(mfdWideCumMode);
                safeSetSimVar('L:CT182T_DBG_WIDE_FPL', 'Number', mfdWideFplEnabled ? 1 : 0);
                safeSetSimVar('L:CT182T_DBG_CUM_FPL', 'Number', mfdWideCumMode ? 1 : 0);
                refreshWideFplPanel();
            };
            viewMenu.addItem(4, 'Wide', function () { mfdWideFplEnabled = true; syncViewIndicators(); }, false);
            viewMenu.addItem(5, 'Narrow', function () { mfdWideFplEnabled = false; syncViewIndicators(); }, true);
            viewMenu.addItem(7, 'Leg-Leg', function () { mfdWideCumMode = false; syncViewIndicators(); }, true);
            viewMenu.addItem(8, 'CUM', function () { mfdWideCumMode = true; syncViewIndicators(); }, false);
            viewMenu.addItem(10, 'Back', function () { menuSys.back(); });
            menuSys.addMenu('view-opt', viewMenu);

            const viewSoftkey = fplnMenu.getItem(4);
            if (viewSoftkey) {
                viewSoftkey.handler = function () { menuSys.pushMenu('view-opt'); };
                if (viewSoftkey.disabled) viewSoftkey.disabled.set(false);
            }
        }
    }

    // --- Item #5 (Direct-To VNV), Item #6 (Name/City Lookup), Item #8 (Map Pointer Snap) ---
    function patchMediumUsabilityUi() {
        patchFacilityLoaderDirectoryHook();
        try {
            const mods = [window.g1000nxipfd, window.g1000nximfd];
            for (let m = 0; m < mods.length; m++) {
                const mod = mods[m];
                if (!mod) continue;

                // Intercept ViewService.routeInteractionEventToViews for custom modal dialogs
                if (mod.ViewService && mod.ViewService.prototype && !mod.ViewService.prototype._wtModalRoutePatched) {
                    mod.ViewService.prototype._wtModalRoutePatched = true;
                    const origRoute = mod.ViewService.prototype.routeInteractionEventToViews;
                    mod.ViewService.prototype.routeInteractionEventToViews = function (evt) {
                        if (customModalState.isOpen) {
                            if (handleCustomModalInteraction(evt, mod.FmsHEvent)) {
                                return true;
                            }
                            closeCustomModal();
                        }
                        return origRoute.apply(this, arguments);
                    };
                }

                // --- Item #6: Facility Name & City Search Controls on WaypointInput ---
                if (mod.UiControl && mod.WaypointInput && mod.WaypointInput.prototype && !mod.WaypointInput.prototype._wtNameCityPatched) {
                    mod.WaypointInput.prototype._wtNameCityPatched = true;
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

                    class WaypointFieldLookupControl extends mod.UiControl {
                        constructor(props) {
                            super(props);
                            this.wptInput = props.wptInput;
                            this.fieldMode = props.fieldMode; // 'city' | 'name'
                            this.targetEl = props.targetEl;
                            this.query = '';
                            this.charPos = 0;
                            this.matches = [];
                            this.savedIcao = '';
                        }
                        getHighlightElement() {
                            return this.targetEl;
                        }
                        onActivated() {
                            super.onActivated();
                            this.savedIcao = (this.wptInput.props && this.wptInput.props.selectedIcao) ? (this.wptInput.props.selectedIcao.get() || '') : '';
                            this.query = '';
                            this.charPos = 0;
                            this.matches = [];
                            if (this.targetEl) {
                                this.targetEl.classList.add(mod.UiControl.FOCUS_CLASS);
                            }
                        }
                        onDeactivated() {
                            super.onDeactivated();
                            if (this.targetEl && this.getIsFocused()) {
                                this.targetEl.classList.add(mod.UiControl.FOCUS_CLASS);
                            }
                        }
                        applyPrefixQuery() {
                            const prefix = this.query.trim();
                            const dispWpt = this.wptInput && this.wptInput.store && this.wptInput.store.displayWaypoint;
                            const dispSub = dispWpt && (this.fieldMode === 'city' ? dispWpt.city : dispWpt.name);
                            if (dispSub && typeof dispSub.set === 'function') {
                                dispSub.set(prefix.padEnd(12, '_'));
                            }
                            const filter = this.wptInput.props ? this.wptInput.props.filter : undefined;
                            const pos = getPlaneCoordinates();
                            const found = [];
                            for (const entry of facilityDirectory.values()) {
                                if (!matchesSearchFilter(entry.icao, filter)) continue;
                                const hay = this.fieldMode === 'city' ? entry.cityUpper : entry.nameUpper;
                                if (prefix.length > 0 && hay && hay.indexOf(prefix) === 0) {
                                    const d = (pos && !isNaN(entry.lat)) ? computeDistanceRad(pos.lat, pos.lon, entry.lat, entry.lon) : 0;
                                    found.push({ entry: entry, dist: d });
                                }
                            }
                            found.sort(function (a, b) { return a.dist - b.dist; });
                            this.matches = found.map(function (x) { return x.entry; });
                            safeSetSimVar('L:CT182T_DBG_CITY_MATCHES', 'Number', this.matches.length);
                            if (this.matches.length > 0) {
                                previewIcaoInWaypointInput(this.wptInput, this.matches[0].icao);
                                if (dispSub && typeof dispSub.set === 'function') {
                                    const full = this.fieldMode === 'city' ? this.matches[0].city : this.matches[0].name;
                                    dispSub.set(full || prefix);
                                }
                            }
                        }
                        stepChar(dir) {
                            if (!this.getIsActivated()) {
                                this.activate();
                                this.query = dir > 0 ? 'A' : 'Z';
                                this.charPos = 0;
                                this.applyPrefixQuery();
                                return true;
                            }
                            const curCh = this.query[this.charPos] || 'A';
                            const nextIdx = (chars.indexOf(curCh) + dir + chars.length) % chars.length;
                            const before = this.query.substr(0, this.charPos);
                            this.query = before + chars[nextIdx];
                            this.applyPrefixQuery();
                            return true;
                        }
                        onUpperKnobInc() { return this.stepChar(1); }
                        onUpperKnobDec() { return this.stepChar(-1); }
                        onLowerKnobInc() {
                            if (this.getIsActivated()) {
                                if (this.charPos < 14) {
                                    this.charPos++;
                                    if (this.query.length <= this.charPos) this.query += 'A';
                                    this.applyPrefixQuery();
                                }
                                return true;
                            }
                            return false;
                        }
                        onLowerKnobDec() {
                            if (this.getIsActivated()) {
                                if (this.charPos > 0) {
                                    this.query = this.query.substr(0, this.charPos);
                                    this.charPos--;
                                    this.applyPrefixQuery();
                                }
                                return true;
                            }
                            return false;
                        }
                        onClr() {
                            if (this.getIsActivated()) {
                                this.deactivate();
                                previewIcaoInWaypointInput(this.wptInput, this.savedIcao);
                                return true;
                            }
                            return false;
                        }
                        onEnter() {
                            if (this.getIsActivated()) {
                                const matchedList = this.matches.slice();
                                this.deactivate();
                                if (matchedList.length > 1 && this.wptInput.props && this.wptInput.props.viewService && window.garminsdk) {
                                    const cache = window.garminsdk.GarminFacilityWaypointCache.getCache(this.wptInput.props.bus);
                                    const wpts = matchedList.filter(function (e) { return !!e.rawFacility; }).map(function (e) { return cache.get(e.rawFacility); });
                                    if (wpts.length > 1) {
                                        const dup = this.wptInput.props.viewService.open('WptDup', true).setInput(wpts);
                                        const wi = this.wptInput;
                                        dup.onAccept.on(function (s, fac) {
                                            if (fac && fac.icao) {
                                                recordRecentIcao(fac.icao);
                                                previewIcaoInWaypointInput(wi, fac.icao).then(function () {
                                                    if (!wi._wtIsInsideWptInfo) wi.onInputEnterPressed();
                                                });
                                            }
                                        });
                                        return true;
                                    }
                                }
                                if (matchedList.length >= 1) {
                                    recordRecentIcao(matchedList[0].icao);
                                    if (!this.wptInput._wtIsInsideWptInfo) {
                                        this.wptInput.onInputEnterPressed();
                                    }
                                }
                                return true;
                            }
                            return false;
                        }
                    }

                    const origWptAfterRender = mod.WaypointInput.prototype.onAfterRender;
                    mod.WaypointInput.prototype.onAfterRender = function (node) {
                        if (typeof origWptAfterRender === 'function') {
                            origWptAfterRender.apply(this, arguments);
                        }
                        try {
                            const rootEl = (this.inputComponentRef && this.inputComponentRef.instance && this.inputComponentRef.instance.getHighlightElement && this.inputComponentRef.instance.getHighlightElement())
                                ? this.inputComponentRef.instance.getHighlightElement().closest('.wpt-entry')
                                : null;
                            const isProcDialog = !!(rootEl && typeof rootEl.closest === 'function' && rootEl.closest('.pfd-proc, .mfd-proc'));
                            if (!isProcDialog && rootEl && typeof rootEl.querySelector === 'function' && typeof this.register === 'function') {
                                const cityEl = rootEl.querySelector('.wpt-entry-location');
                                const nameEl = rootEl.querySelector('.wpt-entry-name');
                                if (cityEl && !this._wtCityLookupCtrl) {
                                    this._wtCityLookupCtrl = new WaypointFieldLookupControl({ wptInput: this, fieldMode: 'city', targetEl: cityEl, onRegister: this.register });
                                    this.register(this._wtCityLookupCtrl);
                                }
                                if (nameEl && !this._wtNameLookupCtrl) {
                                    this._wtNameLookupCtrl = new WaypointFieldLookupControl({ wptInput: this, fieldMode: 'name', targetEl: nameEl, onRegister: this.register });
                                    this.register(this._wtNameLookupCtrl);
                                }
                            }
                        } catch (e) {}
                    };
                }

                // --- Item #5: Direct-To Interactive VNV Altitude & Offset (PFD & MFD) ---
                if (mod.UiControl && mod.DirectTo && mod.DirectTo.prototype && mod.DirectToController && mod.DirectToController.prototype && !mod.DirectTo.prototype._wtDtoVnvPatched) {
                    mod.DirectTo.prototype._wtDtoVnvPatched = true;

                    class DtoInlineValueControl extends mod.UiControl {
                        constructor(props) {
                            super(props);
                            this.targetEl = props.targetEl;
                            this.onStep = props.onStep;
                            this.onClear = props.onClear;
                        }
                        getHighlightElement() { return this.targetEl; }
                        onUpperKnobInc() { this.onStep(1); return true; }
                        onUpperKnobDec() { this.onStep(-1); return true; }
                        onClr() { return this.onClear(); }
                        onEnter() {
                            if (typeof propsJumpToActivate === 'function') propsJumpToActivate();
                            return false;
                        }
                    }
                    let propsJumpToActivate = null;

                    const origDtoAfterRender = mod.DirectTo.prototype.onAfterRender;
                    mod.DirectTo.prototype.onAfterRender = function (thisNode) {
                        if (typeof origDtoAfterRender === 'function') {
                            origDtoAfterRender.apply(this, arguments);
                        }
                        try {
                            const self = this;
                            self.store._wtVnvAlt = null;
                            self.store._wtVnvOffset = 0;

                            const root = self.viewContainerRef && self.viewContainerRef.instance;
                            if (!root || typeof root.querySelector !== 'function') return;

                            let altEl = null;
                            let ofsEl = null;
                            const mfdBox = root.querySelector('.mfd-dto-vnv-box');
                            const pfdBox = root.querySelector('.pfd-dto-alt-offset');
                            if (mfdBox && mfdBox.children && mfdBox.children.length >= 2) {
                                altEl = mfdBox.children[0];
                                ofsEl = mfdBox.children[1];
                            } else if (pfdBox && pfdBox.children && pfdBox.children.length >= 2) {
                                altEl = pfdBox.children[0].querySelector('span') || pfdBox.children[0];
                                ofsEl = pfdBox.children[1].querySelector('span') || pfdBox.children[1];
                            }
                            if (!altEl || !ofsEl) return;

                            const renderDtoVnv = function () {
                                const a = self.store._wtVnvAlt;
                                const o = self.store._wtVnvOffset || 0;
                                altEl.innerHTML = ((a !== null && a > 0) ? String(a) : '_ _ _ _ _') + '<span class="size12">FT</span>';
                                ofsEl.innerHTML = (o >= 0 ? '+' : '') + String(o) + '<span class="size12">NM</span>';
                                safeSetSimVar('L:CT182T_DBG_DTO_VNV_ALT', 'Number', a || 0);
                                safeSetSimVar('L:CT182T_DBG_DTO_VNV_OFS', 'Number', o);
                            };
                            self._wtRenderDtoVnv = renderDtoVnv;

                            const altCtrl = new DtoInlineValueControl({
                                targetEl: altEl,
                                onStep: function (dir) {
                                    if (self.store._wtVnvAlt === null) {
                                        let initAlt = 2000;
                                        try {
                                            const ia = Number(SimVar.GetSimVarValue('INDICATED ALTITUDE', 'feet'));
                                            if (!isNaN(ia) && ia > 200) initAlt = Math.max(500, Math.round(ia / 500) * 500);
                                        } catch (e) {}
                                        self.store._wtVnvAlt = initAlt;
                                    } else {
                                        self.store._wtVnvAlt = Math.max(100, Math.min(45000, self.store._wtVnvAlt + dir * 100));
                                    }
                                    renderDtoVnv();
                                },
                                onClear: function () {
                                    if (self.store._wtVnvAlt !== null) {
                                        self.store._wtVnvAlt = null;
                                        renderDtoVnv();
                                        return true;
                                    }
                                    return false;
                                }
                            });
                            const ofsCtrl = new DtoInlineValueControl({
                                targetEl: ofsEl,
                                onStep: function (dir) {
                                    self.store._wtVnvOffset = Math.max(-99, Math.min(99, (self.store._wtVnvOffset || 0) + dir));
                                    renderDtoVnv();
                                },
                                onClear: function () {
                                    if (self.store._wtVnvOffset !== 0) {
                                        self.store._wtVnvOffset = 0;
                                        renderDtoVnv();
                                        return true;
                                    }
                                    return false;
                                }
                            });
                            altCtrl.onEnter = function () { self.gotoActivateButton(); return true; };
                            ofsCtrl.onEnter = function () { self.gotoActivateButton(); return true; };

                            // Insert altCtrl & ofsCtrl right after WaypointInput (index 0) in DirectTo.scrollController.controls
                            if (self.scrollController && Array.isArray(self.scrollController.controls) && !self._wtDtoCtrlsInserted) {
                                self._wtDtoCtrlsInserted = true;
                                self.scrollController.controls.splice(1, 0, altCtrl, ofsCtrl);
                                altCtrl.onAfterRender();
                                ofsCtrl.onAfterRender();
                            }
                            renderDtoVnv();
                        } catch (e) {}
                    };

                    const origGetActIdx = mod.DirectTo.prototype.getActivateScrollIndex;
                    mod.DirectTo.prototype.getActivateScrollIndex = function () {
                        if (this._wtDtoCtrlsInserted) {
                            return 4; // [0: WaypointInput, 1: VnvAlt, 2: VnvOffset, 3: Course, 4: Activate?, 5: Hold?]
                        }
                        return origGetActIdx.apply(this, arguments);
                    };

                    const origDtoOpened = mod.DirectTo.prototype.onViewOpened;
                    mod.DirectTo.prototype.onViewOpened = function () {
                        if (this.store) {
                            this.store._wtVnvAlt = null;
                            this.store._wtVnvOffset = 0;
                            if (typeof this._wtRenderDtoVnv === 'function') this._wtRenderDtoVnv();
                        }
                        return origDtoOpened.apply(this, arguments);
                    };

                    const origActivateSel = mod.DirectToController.prototype.activateSelected;
                    mod.DirectToController.prototype.activateSelected = function (holdAt) {
                        const vnvAlt = this.store ? this.store._wtVnvAlt : null;
                        const vnvOfs = this.store ? (this.store._wtVnvOffset || 0) : 0;
                        if (!holdAt && ((vnvAlt !== null && vnvAlt > 0) || vnvOfs !== 0)) {
                            const selectedWaypoint = this.store.waypoint.get();
                            const facility = (selectedWaypoint && sdk.FacilityWaypointUtils && sdk.FacilityWaypointUtils.isFacilityWaypoint(selectedWaypoint))
                                ? selectedWaypoint.facility.get()
                                : null;
                            const course = this.store.course.get();
                            if (facility && this.fms) {
                                const selfCtrl = this;
                                (async function () {
                                    try {
                                        let segIdx = -1;
                                        let legIdx = -1;
                                        if (selfCtrl.directToExistingData) {
                                            segIdx = selfCtrl.directToExistingData.segmentIndex;
                                            legIdx = selfCtrl.directToExistingData.segmentLegIndex;
                                        } else {
                                            // Ensure target exists in Primary Flight Plan (0) so SmoothingPathCalculator computes VNAV!
                                            const plan = selfCtrl.fms.getPrimaryFlightPlan();
                                            const enrIdx = selfCtrl.fms.findLastEnrouteSegmentIndex(plan);
                                            const enrSeg = plan.tryGetSegment(enrIdx);
                                            if (enrSeg) {
                                                const pos = getPlaneCoordinates();
                                                if (plan.length === 0 && pos) {
                                                    const pposFac = registerUserFacilityInRepo('DTOPP', pos.lat, pos.lon, true, 'DIRECT ORIGIN');
                                                    selfCtrl.fms.insertWaypoint(enrIdx, pposFac, 0);
                                                }
                                                selfCtrl.fms.insertWaypoint(enrIdx, facility);
                                                segIdx = enrIdx;
                                                legIdx = plan.getSegment(enrIdx).legs.length - 1;
                                            }
                                        }
                                        if (segIdx >= 0 && legIdx >= 0) {
                                            const plan = selfCtrl.fms.getPrimaryFlightPlan();
                                            if (vnvOfs !== 0) {
                                                const gIdx = plan.getSegment(segIdx).offset + legIdx;
                                                const ld = plan.tryGetLeg(segIdx, legIdx);
                                                const atkFac = await createAndInsertAtkOffsetWaypoint({
                                                    plan: plan, legDef: ld, segmentIndex: segIdx, segmentLegIndex: legIdx, globalIndex: gIdx, fixIcao: facility.icao
                                                }, vnvOfs, vnvAlt || undefined);
                                                if (atkFac) {
                                                    const updSeg = plan.getSegment(segIdx);
                                                    const atkIdx = updSeg.legs.findIndex(function (l) { return l && l.leg && l.leg.fixIcao === atkFac.icao; });
                                                    if (atkIdx >= 0) {
                                                        selfCtrl.fms.createDirectToExisting(segIdx, vnvOfs < 0 ? atkIdx : legIdx, course);
                                                        return;
                                                    }
                                                }
                                            }
                                            if (vnvAlt !== null && vnvAlt > 0 && typeof selfCtrl.fms.setUserConstraint === 'function') {
                                                selfCtrl.fms.setUserConstraint(segIdx, legIdx, vnvAlt);
                                            }
                                            selfCtrl.fms.createDirectToExisting(segIdx, legIdx, course);
                                        }
                                    } catch (e) {}
                                })();
                                return;
                            }
                        }
                        return origActivateSel.apply(this, arguments);
                    };
                }

                // --- Item #8: Map Pointer Feature Snap, ENT Info, D->, Load WPT & Measure BRG/DIST ---
                const mapPages = [mod.MFDNavMapPage, mod.MFDFPLPage];
                for (let p = 0; p < mapPages.length; p++) {
                    const MapPageCls = mapPages[p];
                    if (!MapPageCls || !MapPageCls.prototype || MapPageCls.prototype._wtMapPtrPatched) {
                        continue;
                    }
                    MapPageCls.prototype._wtMapPtrPatched = true;

                    const getPointerState = function (pageInst) {
                        if (!pageInst.mapPointerModule || !pageInst.mapPointerModule.isActive.get() || !pageInst.compiledMap) {
                            return null;
                        }
                        try {
                            const proj = pageInst.compiledMap.context.projection;
                            const pxPos = pageInst.mapPointerModule.position.get();
                            const geo = proj.invert(pxPos, new sdk.GeoPoint(0, 0));
                            if (!geo || isNaN(geo.lat) || isNaN(geo.lon)) return null;

                            let bestEntry = null;
                            let bestPxDist = 26; // Snap within 26 pixels of crosshair
                            const tmpPx = new Float64Array(2);
                            for (const entry of facilityDirectory.values()) {
                                if (isNaN(entry.lat) || isNaN(entry.lon)) continue;
                                proj.project(entry, tmpPx);
                                const dx = tmpPx[0] - pxPos[0];
                                const dy = tmpPx[1] - pxPos[1];
                                const d = Math.sqrt(dx * dx + dy * dy);
                                if (d < bestPxDist) {
                                    bestPxDist = d;
                                    bestEntry = entry;
                                }
                            }
                            return { lat: geo.lat, lon: geo.lon, snapped: bestEntry };
                        } catch (e) {
                            return null;
                        }
                    };

                    const updatePointerBanner = function (pageInst) {
                        if (typeof document === 'undefined' || !document.body) return;
                        ensureCustomModalDom();
                        if (!pageInst._wtPtrBannerEl) {
                            const b = document.createElement('div');
                            b.className = 'wt-map-ptr-banner';
                            b.style.display = 'none';
                            document.body.appendChild(b);
                            pageInst._wtPtrBannerEl = b;
                        }
                        const st = getPointerState(pageInst);
                        if (!st) {
                            pageInst._wtPtrBannerEl.style.display = 'none';
                            safeSetSimVar('L:CT182T_DBG_MAP_PTR_ACTIVE', 'Number', 0);
                            return;
                        }
                        safeSetSimVar('L:CT182T_DBG_MAP_PTR_ACTIVE', 'Number', 1);
                        pageInst._wtPtrBannerEl.style.top = (pageInst === mfdFplPageInstance && mfdWideFplEnabled) ? '402px' : '62px';
                        pageInst._wtPtrBannerEl.style.display = 'block';
                        let txt = '';
                        if (st.snapped) {
                            txt = st.snapped.ident + (st.snapped.name ? (' \u2014 ' + st.snapped.name.substr(0, 22)) : '') + '  [ENT: Info \u2022 D\u2192: Direct]';
                        } else {
                            txt = (st.lat >= 0 ? 'N' : 'S') + Math.abs(st.lat).toFixed(3) + '\u00B0 '
                                + (st.lon >= 0 ? 'E' : 'W') + Math.abs(st.lon).toFixed(3) + '\u00B0  [D\u2192: Direct \u2022 MENU: Load WPT]';
                        }
                        if (pageInst._wtMeasureOrigin) {
                            const mBrg = Math.round(computeBearingDegTrue(pageInst._wtMeasureOrigin.lat, pageInst._wtMeasureOrigin.lon, st.lat, st.lon));
                            const mDis = computeDistanceRad(pageInst._wtMeasureOrigin.lat, pageInst._wtMeasureOrigin.lon, st.lat, st.lon) * (180 / Math.PI) * 60;
                            txt += '  |  MEAS ' + String(mBrg === 0 ? 360 : mBrg).padStart(3, '0') + '\u00B0 / ' + mDis.toFixed(1) + 'NM';
                        }
                        pageInst._wtPtrBannerEl.textContent = txt;
                    };

                    const origMapViewClosed = MapPageCls.prototype.onViewClosed;
                    if (typeof origMapViewClosed === 'function') {
                        MapPageCls.prototype.onViewClosed = function () {
                            if (this._wtPtrBannerEl) {
                                this._wtPtrBannerEl.style.display = 'none';
                            }
                            safeSetSimVar('L:CT182T_DBG_MAP_PTR_ACTIVE', 'Number', 0);
                            return origMapViewClosed.apply(this, arguments);
                        };
                    }

                    const origHandleMove = MapPageCls.prototype.handleMapPointerMoveEvent;
                    MapPageCls.prototype.handleMapPointerMoveEvent = function (evt) {
                        const res = origHandleMove.apply(this, arguments);
                        if (this.mapPointerModule && this.mapPointerModule.isActive.get()) {
                            updatePointerBanner(this);
                            if (evt === mod.FmsHEvent.ENT) {
                                const st = getPointerState(this);
                                if (st && st.snapped) {
                                    this.mapPointerController.setPointerActive(false);
                                    updatePointerBanner(this);
                                    const ft = st.snapped.facType;
                                    const FT = sdk.FacilityType || {};
                                    let pageKey = 'AirportInformation';
                                    if (ft === FT.VOR) pageKey = 'VorInformation';
                                    else if (ft === FT.NDB) pageKey = 'NdbInformation';
                                    else if (ft === FT.Intersection) pageKey = 'IntersectionInformation';
                                    if (ft === FT.USR) {
                                        this.props.viewService.open('DirectTo').setInput({ icao: st.snapped.icao });
                                    } else {
                                        const infoView = this.props.viewService.open(pageKey);
                                        if (infoView && typeof infoView.setInput === 'function') {
                                            infoView.setInput(st.snapped.icao);
                                        }
                                    }
                                    return true;
                                }
                            }
                            if (evt === mod.FmsHEvent.DIRECTTO) {
                                const st = getPointerState(this);
                                if (st) {
                                    this.mapPointerController.setPointerActive(false);
                                    updatePointerBanner(this);
                                    let targetIcao = st.snapped ? st.snapped.icao : '';
                                    if (!targetIcao) {
                                        const mapFac = registerUserFacilityInRepo('MAPWPT', st.lat, st.lon, true, 'MAP POINTER WPT');
                                        targetIcao = mapFac.icao;
                                    }
                                    this.props.viewService.open('DirectTo').setInput({ icao: targetIcao });
                                    return true;
                                }
                            }
                            if (evt === mod.FmsHEvent.CLR) {
                                this._wtMeasureOrigin = null;
                                this.mapPointerController.setPointerActive(false);
                                updatePointerBanner(this);
                                return true;
                            }
                        }
                        return res;
                    };

                    const origPtrClosed = MapPageCls.prototype.onViewClosed;
                    MapPageCls.prototype.onViewClosed = function () {
                        this._wtMeasureOrigin = null;
                        if (this._wtPtrBannerEl) this._wtPtrBannerEl.style.display = 'none';
                        return origPtrClosed.apply(this, arguments);
                    };

                    if (MapPageCls === mod.MFDNavMapPage) {
                        const origNavInteraction = MapPageCls.prototype.onInteractionEvent;
                        MapPageCls.prototype.onInteractionEvent = function (evt) {
                            const res = origNavInteraction.apply(this, arguments);
                            if (evt === mod.FmsHEvent.JOYSTICK_PUSH) {
                                if (!this.mapPointerModule.isActive.get()) this._wtMeasureOrigin = null;
                                updatePointerBanner(this);
                            }
                            return res;
                        };

                        MapPageCls.prototype.onMenuPressed = function () {
                            const self = this;
                            if (Array.isArray(self.pageMenuItems)) {
                                for (let i = 0; i < self.pageMenuItems.length; i++) {
                                    if (self.pageMenuItems[i].id === 'measure-brg-dist') {
                                        self.pageMenuItems[i].isEnabled = true;
                                        self.pageMenuItems[i].action = function () {
                                            if (!self.mapPointerModule.isActive.get()) {
                                                self.mapPointerController.setPointerActive(true);
                                            }
                                            const st = getPointerState(self);
                                            if (st) {
                                                self._wtMeasureOrigin = { lat: st.lat, lon: st.lon };
                                                updatePointerBanner(self);
                                            }
                                        };
                                    }
                                }
                                if (!self.pageMenuItems.some(function (x) { return x.id === 'load-ptr-wpt'; })) {
                                    self.pageMenuItems.splice(2, 0, {
                                        id: 'load-ptr-wpt',
                                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Load Map Pointer WPT to FPL'); },
                                        isEnabled: true,
                                        action: function () {
                                            const st = getPointerState(self);
                                            if (!st || !submenuFms) return;
                                            const plan = submenuFms.getPrimaryFlightPlan();
                                            const enrIdx = submenuFms.findLastEnrouteSegmentIndex(plan);
                                            if (st.snapped && st.snapped.rawFacility) {
                                                submenuFms.insertWaypoint(enrIdx, st.snapped.rawFacility);
                                            } else {
                                                const mf = registerUserFacilityInRepo('MAPWPT', st.lat, st.lon, false, 'MAP WAYPOINT');
                                                submenuFms.insertWaypoint(enrIdx, mf);
                                            }
                                            self.mapPointerController.setPointerActive(false);
                                            updatePointerBanner(self);
                                        }
                                    });
                                }
                            }
                            self.props.menuSystem.pushMenu('empty');
                            const pageMenu = self.props.viewService.open('PageMenuDialog');
                            pageMenu.setMenuItems(self.pageMenuItems);
                            pageMenu.onClose.on(function () { self.props.menuSystem.back(); });
                            return true;
                        };
                    }
                }

                // --- Item #9: Hook MFDFPLPage, MFDFPLDetails, ScrollBar, and MFDPageSelect ENT ---
                if (mod === window.g1000nximfd) {
                    if (mod.MFDPageSelect && mod.MFDPageSelect.prototype && !mod.MFDPageSelect.prototype._wtEntClosePatched) {
                        mod.MFDPageSelect.prototype._wtEntClosePatched = true;
                        const origPsEvt = mod.MFDPageSelect.prototype.onInteractionEvent;
                        mod.MFDPageSelect.prototype.onInteractionEvent = function (evt) {
                            if (evt === mod.FmsHEvent.ENT) {
                                this.close();
                                return true;
                            }
                            return origPsEvt.apply(this, arguments);
                        };
                    }
                    if (mod.ScrollBar && mod.ScrollBar.prototype && !mod.ScrollBar.prototype._wtWideSbPatched) {
                        mod.ScrollBar.prototype._wtWideSbPatched = true;
                        const origSbRender = mod.ScrollBar.prototype.onAfterRender;
                        mod.ScrollBar.prototype.onAfterRender = function () {
                            if (typeof origSbRender === 'function') {
                                origSbRender.apply(this, arguments);
                            }
                            if (mfdScrollBars.indexOf(this) < 0) {
                                mfdScrollBars.push(this);
                            }
                        };
                    }
                    if (mod.MFDFPLDetails && mod.MFDFPLDetails.prototype && !mod.MFDFPLDetails.prototype._wtWideDetPatched) {
                        mod.MFDFPLDetails.prototype._wtWideDetPatched = true;
                        const origDetRender = mod.MFDFPLDetails.prototype.onAfterRender;
                        mod.MFDFPLDetails.prototype.onAfterRender = function () {
                            if (typeof origDetRender === 'function') {
                                origDetRender.apply(this, arguments);
                            }
                            mfdFplDetailsInstance = this;
                            ensureWideFplHeaders(this);
                            refreshWideFplPanel();
                        };
                        const origDetOpen = mod.MFDFPLDetails.prototype.fplViewOpened;
                        mod.MFDFPLDetails.prototype.fplViewOpened = function () {
                            if (typeof origDetOpen === 'function') {
                                origDetOpen.apply(this, arguments);
                            }
                            mfdFplDetailsInstance = this;
                            ensureWideFplHeaders(this);
                            refreshWideFplPanel();
                        };
                    }
                    if (mod.MFDFPLPage && mod.MFDFPLPage.prototype && !mod.MFDFPLPage.prototype._wtWidePagePatched) {
                        mod.MFDFPLPage.prototype._wtWidePagePatched = true;
                        const origFplPageRender = mod.MFDFPLPage.prototype.onAfterRender;
                        mod.MFDFPLPage.prototype.onAfterRender = function () {
                            if (typeof origFplPageRender === 'function') {
                                origFplPageRender.apply(this, arguments);
                            }
                            mfdFplPageInstance = this;
                            refreshWideFplPanel();
                        };
                        const origFplPageOpen = mod.MFDFPLPage.prototype.onViewOpened;
                        mod.MFDFPLPage.prototype.onViewOpened = function () {
                            if (typeof origFplPageOpen === 'function') {
                                origFplPageOpen.apply(this, arguments);
                            }
                            mfdFplPageInstance = this;
                            refreshWideFplPanel();
                            if (typeof setTimeout === 'function') {
                                setTimeout(refreshWideFplPanel, 60);
                            }
                        };
                        const origFplSetScroll = mod.MFDFPLPage.prototype.setScrollEnabled;
                        if (typeof origFplSetScroll === 'function') {
                            mod.MFDFPLPage.prototype.setScrollEnabled = function (enabled) {
                                if (!enabled) {
                                    lastMfdFplSelectedLeg = null;
                                    lastFocusedFplFixCtrl = null;
                                }
                                return origFplSetScroll.apply(this, arguments);
                            };
                        }
                        const origFplPageClose = mod.MFDFPLPage.prototype.onViewClosed;
                        mod.MFDFPLPage.prototype.onViewClosed = function () {
                            try {
                                if (typeof this.setScrollEnabled === 'function') {
                                    this.setScrollEnabled(false);
                                }
                            } catch (e) {}
                            if (typeof origFplPageClose === 'function') {
                                return origFplPageClose.apply(this, arguments);
                            }
                        };
                    }
                }
            }
        } catch (e) {
            console.error('CT182TGfc700Plugin: patchMediumUsabilityUi error', e);
        }
    }

    // --- Items #10, #11, #13: Register Custom MFD Pages (Flight Plan Catalog, User WPT Info, Nearest Frequencies, Nearest User WPTs) ---
    let mfdCustomPagesRegistered = false;
    function registerMediumMfdPages(vs) {
        if (!isMfdContext || !vs || mfdCustomPagesRegistered || typeof vs.registerView !== 'function') {
            return;
        }
        const mfdMod = window.g1000nximfd;
        if (!mfdMod || !mfdMod.MFDUiPage || !pluginMenuSystem) {
            return;
        }
        mfdCustomPagesRegistered = true;

        try {
            vs.openPageKey.sub(function () {
                refreshWideFplPanel();
            });
        } catch (e) {}

        // Register dedicated softkey menus for Flight Plan Catalog & User WPT Information
        let activeCatalogPage = null;
        let activeUserWptPage = null;
        if (mfdMod.SoftKeyMenu && typeof pluginMenuSystem.addMenu === 'function') {
            const catMenu = new mfdMod.SoftKeyMenu(pluginMenuSystem);
            catMenu.addItem(2, 'Map Opt', function () { pluginMenuSystem.pushMenu('map-opt'); });
            catMenu.addItem(3, 'New', function () {
                if (activeCatalogPage) {
                    storeCurrentPrimaryFlightPlan();
                    activeCatalogPage.refreshRows();
                }
            });
            catMenu.addItem(4, 'Activate', function () {
                if (activeCatalogPage && activeCatalogPage.rows[activeCatalogPage.selectedIdx]) {
                    activeCatalogPage.onRowEnter(activeCatalogPage.rows[activeCatalogPage.selectedIdx]);
                }
            });
            catMenu.addItem(5, 'Invert', function () {
                if (activeCatalogPage && activeCatalogPage.rows[activeCatalogPage.selectedIdx]) {
                    const r = activeCatalogPage.rows[activeCatalogPage.selectedIdx];
                    if (r && r.rec) {
                        activateStoredFlightPlanRecord(r.rec, true).then(function () {
                            activeCatalogPage.props.viewService.open('FPLPage');
                        });
                    }
                }
            });
            catMenu.addItem(7, 'Delete', function () {
                if (activeCatalogPage && activeCatalogPage.rows[activeCatalogPage.selectedIdx]) {
                    activeCatalogPage.onRowClr(activeCatalogPage.rows[activeCatalogPage.selectedIdx]);
                }
            });
            pluginMenuSystem.addMenu('wt-fpl-catalog-menu', catMenu);

            const usrMenu = new mfdMod.SoftKeyMenu(pluginMenuSystem);
            usrMenu.addItem(2, 'Map Opt', function () { pluginMenuSystem.pushMenu('map-opt'); });
            usrMenu.addItem(3, 'New', function () { openCreateUserWaypointDialog(); });
            usrMenu.addItem(7, 'Delete', function () {
                if (activeUserWptPage && activeUserWptPage.rows[activeUserWptPage.selectedIdx]) {
                    activeUserWptPage.onRowClr(activeUserWptPage.rows[activeUserWptPage.selectedIdx]);
                }
            });
            pluginMenuSystem.addMenu('wt-user-wpt-menu', usrMenu);
        }

        function formatDegMinCoord(val, isLat) {
            const hem = isLat ? (val >= 0 ? 'N' : 'S') : (val >= 0 ? 'E' : 'W');
            const abs = Math.abs(val);
            const deg = Math.floor(abs);
            const min = (abs - deg) * 60;
            const degStr = String(deg).padStart(isLat ? 2 : 3, '0');
            return hem + ' ' + degStr + '\u00B0' + min.toFixed(2).padStart(5, '0') + "'";
        }

        class BaseCustomListMfdPage extends mfdMod.MFDUiPage {
            constructor(props) {
                super(props);
                this.contentRef = sdk.FSComponent.createRef();
                this.rows = [];
                this.selectedIdx = 0;
                this.compiledMap = null;
                this.mapRangeModule = null;
                this.mapRangeController = null;
                try {
                    const gsdk = window.garminsdk;
                    if (sdk.MapSystemBuilder && mfdMod.MapBuilder && mfdMod.MapUserSettings && gsdk && gsdk.UnitsUserSettings) {
                        this.compiledMap = sdk.MapSystemBuilder.create(this.props.bus)
                            .with(mfdMod.MapBuilder.navMap, Object.assign({
                                bingId: 'mfd-page-map',
                                dataUpdateFreq: 15,
                                waypointIconImageCache: mfdMod.MapWaypointIconImageCache.getCache(),
                                waypointStyleFontType: 'Roboto',
                                rangeRingOptions: { showLabel: true },
                                rangeCompassOptions: {
                                    showLabel: true, showHeadingBug: true,
                                    bearingTickMajorLength: 10, bearingTickMinorLength: 5,
                                    bearingLabelFont: 'Roboto-Bold', bearingLabelFontSize: 20
                                },
                                flightPlanner: submenuFms ? submenuFms.flightPlanner : undefined,
                                miniCompassImgSrc: mfdMod.MapBuilder.miniCompassIconSrc(),
                                settingManager: mfdMod.MapUserSettings.getMfdManager(this.props.bus),
                                unitsSettingManager: gsdk.UnitsUserSettings.getManager(this.props.bus)
                            }, mfdMod.MapBuilder.ownAirplaneIconOptions()))
                            .withProjectedSize(sdk.Vec2Math.create(440, 734))
                            .withDeadZone(sdk.VecNMath.create(4, 0, 56, 0, 0))
                            .withClockUpdate(15)
                            .build('mfd-fplmap');
                        this.mapRangeModule = this.compiledMap.context.model.getModule(gsdk.GarminMapKeys.Range);
                        this.mapRangeController = this.compiledMap.context.getController(gsdk.GarminMapKeys.Range);
                    }
                } catch (e) {
                    this.compiledMap = null;
                }
            }
            onAfterRender(thisNode) {
                super.onAfterRender(thisNode);
                if (this.compiledMap && this.compiledMap.ref && this.compiledMap.ref.instance) {
                    this.compiledMap.ref.instance.sleep();
                }
            }
            getRootMenuName() { return 'navmap-root'; }
            getTopBoxTitle() { return null; }
            getTopBoxLines() { return []; }
            getListBoxTitle() { return this.getHeaderLeft(); }
            getColHeaders() { return null; }
            getInfoBoxTitle() { return 'Information'; }
            getInfoBoxLines() { return []; }
            getBottomPrompt() { return 'Press FMS CRSR to select  •  MENU for options'; }
            onViewOpened() {
                super.onViewOpened();
                this.props.viewService.clearPageHistory();
                this.props.menuSystem.clear();
                this.props.menuSystem.pushMenu(this.getRootMenuName());
                if (this.compiledMap && this.compiledMap.ref && this.compiledMap.ref.instance) {
                    this.compiledMap.ref.instance.wake();
                }
                this.selectedIdx = 0;
                this.refreshRows();
            }
            onViewClosed() {
                super.onViewClosed();
                if (this.compiledMap && this.compiledMap.ref && this.compiledMap.ref.instance) {
                    this.compiledMap.ref.instance.sleep();
                }
            }
            processHEvent(evt) {
                if (evt === mfdMod.FmsHEvent.RANGE_DEC && this.mapRangeModule && this.mapRangeController) {
                    const idx = Math.max(0, this.mapRangeModule.nominalRangeIndex.get() - 1);
                    this.mapRangeController.setRangeIndex(idx);
                    return true;
                }
                if (evt === mfdMod.FmsHEvent.RANGE_INC && this.mapRangeModule && this.mapRangeController) {
                    const maxIdx = this.mapRangeModule.nominalRanges.get().length - 1;
                    const idx = Math.min(maxIdx, this.mapRangeModule.nominalRangeIndex.get() + 1);
                    this.mapRangeController.setRangeIndex(idx);
                    return true;
                }
                if (evt === mfdMod.FmsHEvent.UPPER_PUSH) {
                    this.toggleScroll();
                    this.renderDomRows();
                    return true;
                }
                if (this.scrollController.getIsScrollEnabled()) {
                    if (evt === mfdMod.FmsHEvent.LOWER_INC || evt === mfdMod.FmsHEvent.UPPER_INC) {
                        if (this.selectedIdx < this.rows.length - 1) {
                            this.selectedIdx++;
                            this.renderDomRows();
                        }
                        return true;
                    }
                    if (evt === mfdMod.FmsHEvent.LOWER_DEC || evt === mfdMod.FmsHEvent.UPPER_DEC) {
                        if (this.selectedIdx > 0) {
                            this.selectedIdx--;
                            this.renderDomRows();
                        }
                        return true;
                    }
                    if (evt === mfdMod.FmsHEvent.ENT) {
                        return this.onRowEnter(this.rows[this.selectedIdx]);
                    }
                    if (evt === mfdMod.FmsHEvent.CLR) {
                        return this.onRowClr(this.rows[this.selectedIdx]);
                    }
                    if (evt === mfdMod.FmsHEvent.DIRECTTO) {
                        return this.onRowDirectTo(this.rows[this.selectedIdx]);
                    }
                }
                return super.processHEvent(evt);
            }
            onRowEnter() { return false; }
            onRowClr() { return false; }
            onRowDirectTo() { return false; }
            buildGroupBoxEl(titleText, minHeightPx) {
                const wrap = document.createElement('div');
                wrap.className = 'wt-custom-gbox';
                const t = document.createElement('div');
                t.className = 'wt-custom-gbox-title';
                t.textContent = titleText;
                const b = document.createElement('div');
                b.className = 'wt-custom-gbox-body';
                if (minHeightPx) b.style.minHeight = minHeightPx + 'px';
                wrap.appendChild(t);
                wrap.appendChild(b);
                return { wrap: wrap, body: b };
            }
            renderDomRows() {
                ensureCustomModalDom();
                const el = this.contentRef.instance;
                if (!el) return;
                while (el.firstChild) el.removeChild(el.firstChild);

                const topTitle = this.getTopBoxTitle();
                if (topTitle) {
                    const topGb = this.buildGroupBoxEl(topTitle, 38);
                    const topLines = this.getTopBoxLines();
                    for (let i = 0; i < topLines.length; i++) {
                        const ln = document.createElement('div');
                        ln.className = 'wt-custom-info-line';
                        ln.innerHTML = '<span>' + topLines[i][0] + '</span><span>' + topLines[i][1] + '</span>';
                        topGb.body.appendChild(ln);
                    }
                    el.appendChild(topGb.wrap);
                }

                const maxVisible = topTitle ? 11 : 13;
                const listGb = this.buildGroupBoxEl(this.getListBoxTitle(), topTitle ? 330 : 390);
                const colHdr = this.getColHeaders();
                if (colHdr) {
                    const ch = document.createElement('div');
                    ch.className = 'wt-custom-colhdr';
                    ch.innerHTML = '<span>' + colHdr[0] + '</span><span>' + colHdr[1] + '</span>';
                    listGb.body.appendChild(ch);
                }

                const cursorOn = this.scrollController.getIsScrollEnabled();
                if (this.rows.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'wt-custom-page-row';
                    empty.style.color = '#9ca6b2';
                    empty.textContent = this.getEmptyMessage();
                    listGb.body.appendChild(empty);
                } else {
                    const start = Math.max(0, Math.min(this.selectedIdx - Math.floor(maxVisible / 2), Math.max(0, this.rows.length - maxVisible)));
                    const end = Math.min(this.rows.length, start + maxVisible);
                    for (let i = start; i < end; i++) {
                        const r = document.createElement('div');
                        r.className = 'wt-custom-page-row' + ((cursorOn && i === this.selectedIdx) ? ' wt-selected' : '');
                        r.innerHTML = '<span>' + this.rows[i].left + '</span><span>' + this.rows[i].right + '</span>';
                        listGb.body.appendChild(r);
                    }
                }
                el.appendChild(listGb.wrap);

                const curRow = this.rows[this.selectedIdx] || null;
                const infoGb = this.buildGroupBoxEl(this.getInfoBoxTitle(), 118);
                const infoLines = this.getInfoBoxLines(curRow);
                for (let j = 0; j < infoLines.length; j++) {
                    const il = document.createElement('div');
                    il.className = 'wt-custom-info-line';
                    il.innerHTML = '<span>' + infoLines[j][0] + '</span><span>' + infoLines[j][1] + '</span>';
                    infoGb.body.appendChild(il);
                }
                el.appendChild(infoGb.wrap);

                const pr = document.createElement('div');
                pr.className = 'wt-custom-prompt';
                pr.textContent = this.getBottomPrompt();
                el.appendChild(pr);

                try {
                    const pageEl = this.viewContainerRef && this.viewContainerRef.instance;
                    if (pageEl && typeof el.getBoundingClientRect === 'function') {
                        const paneRect = el.getBoundingClientRect();
                        const mapNode = pageEl.querySelector('.mfd-fplmap');
                        const mapRect = mapNode ? mapNode.getBoundingClientRect() : null;
                        const ok = (paneRect.top >= 46 && paneRect.left >= 580 && paneRect.width >= 430 && paneRect.bottom <= 736 && (!mapRect || mapRect.width === 440)) ? 1 : 0;
                        safeSetSimVar('L:CT182T_DBG_CUSTPAGE_OK', 'Number', ok);
                    }
                } catch (e) {}
            }
            render() {
                if (this.compiledMap && this.compiledMap.map) {
                    return sdk.FSComponent.buildComponent('div', { ref: this.viewContainerRef, class: 'mfd-page' },
                        this.compiledMap.map,
                        sdk.FSComponent.buildComponent('div', { ref: this.contentRef, class: 'wt-custom-pane' }));
                }
                return sdk.FSComponent.buildComponent('div', { ref: this.viewContainerRef, class: 'mfd-page' },
                    sdk.FSComponent.buildComponent('div', { ref: this.contentRef, class: 'wt-custom-pane' }));
            }
        }

        // 1. FPL – Flight Plan Catalog (Item #10)
        class MFDStoredFplCatalogPage extends BaseCustomListMfdPage {
            constructor(props) {
                super(props);
                this._title.set('FPL \u2013 Flight Plan Catalog');
            }
            getRootMenuName() { return 'wt-fpl-catalog-menu'; }
            getTopBoxTitle() { return 'Flight Plan Catalog'; }
            getTopBoxLines() {
                const used = this.rows.length;
                return [['Used   ' + used, 'Empty   ' + Math.max(0, 99 - used)]];
            }
            getListBoxTitle() { return 'Flight Plan List'; }
            getColHeaders() { return ['#    COMMENT', 'WPTS']; }
            getInfoBoxTitle() { return 'Flight Plan Info'; }
            getInfoBoxLines(cur) {
                if (!cur || !cur.rec) {
                    return [['Departure', '______'], ['Destination', '______'], ['Total Waypoints', '0']];
                }
                const orig = cur.rec.originIcao ? sdk.ICAO.getIdent(cur.rec.originIcao).trim() : '______';
                const dst = cur.rec.destIcao ? sdk.ICAO.getIdent(cur.rec.destIcao).trim() : '______';
                return [['Departure', orig], ['Destination', dst], ['Total Waypoints', String(cur.wptCnt)]];
            }
            getBottomPrompt() { return 'ENT: Activate  •  MENU: Catalog Options  •  CLR: Delete'; }
            getEmptyMessage() { return 'No stored flight plans (Press New or MENU to store)'; }
            onViewOpened() {
                activeCatalogPage = this;
                super.onViewOpened();
            }
            refreshRows() {
                const stored = loadStoredFlightPlans();
                this.rows = stored.map(function (rec, idx) {
                    const wptCnt = (rec.originIcao ? 1 : 0) + (Array.isArray(rec.enrouteIcaos) ? rec.enrouteIcaos.length : 0) + (rec.destIcao ? 1 : 0);
                    return { rec: rec, wptCnt: wptCnt, left: String(idx + 1).padStart(2, ' ') + '   ' + rec.title, right: String(wptCnt) };
                });
                if (this.selectedIdx >= this.rows.length) this.selectedIdx = Math.max(0, this.rows.length - 1);
                this.renderDomRows();
            }
            onRowEnter(row) {
                if (!row || !row.rec) return false;
                const self = this;
                activateStoredFlightPlanRecord(row.rec, false).then(function () {
                    self.props.viewService.open('FPLPage');
                });
                return true;
            }
            onRowClr(row) {
                if (!row || !row.rec) return false;
                const list = loadStoredFlightPlans().filter(function (x) { return x.id !== row.rec.id; });
                saveStoredFlightPlans(list);
                this.refreshRows();
                return true;
            }
            onMenuPressed() {
                const self = this;
                const cur = self.rows[self.selectedIdx];
                const dlg = self.props.viewService.open('PageMenuDialog');
                dlg.setMenuItems([
                    {
                        id: 'cat-act',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Activate Flight Plan'); },
                        isEnabled: !!cur,
                        action: function () { if (cur) self.onRowEnter(cur); }
                    },
                    {
                        id: 'cat-inv',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Activate Inverted'); },
                        isEnabled: !!cur,
                        action: function () {
                            if (cur) activateStoredFlightPlanRecord(cur.rec, true).then(function () { self.props.viewService.open('FPLPage'); });
                        }
                    },
                    {
                        id: 'cat-store',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Store Active Flight Plan'); },
                        isEnabled: true,
                        action: function () { storeCurrentPrimaryFlightPlan(); self.refreshRows(); }
                    },
                    {
                        id: 'cat-del',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Delete Flight Plan'); },
                        isEnabled: !!cur,
                        action: function () { if (cur) self.onRowClr(cur); }
                    }
                ]);
                return true;
            }
        }

        // 2. WPT – User WPT Information (Item #11)
        class MFDUserWptInfoPage extends BaseCustomListMfdPage {
            constructor(props) {
                super(props);
                this._title.set('WPT \u2013 User WPT Information');
            }
            getRootMenuName() { return 'wt-user-wpt-menu'; }
            getListBoxTitle() { return 'User Waypoint List (' + this.rows.length + ')'; }
            getColHeaders() { return ['IDENTIFIER', 'LAT / LON']; }
            getInfoBoxTitle() { return 'Information'; }
            getInfoBoxLines(cur) {
                if (!cur || !cur.u) {
                    return [['Identifier', '______'], ['Latitude', '__\u00B0__.__\''], ['Longitude', '___\u00B0__.__\'']];
                }
                return [
                    ['Identifier', cur.u.ident],
                    ['Latitude', formatDegMinCoord(cur.u.lat, true)],
                    ['Longitude', formatDegMinCoord(cur.u.lon, false)]
                ];
            }
            getBottomPrompt() { return 'New / ENT: Create WPT  •  D\u2192: Direct  •  CLR: Delete'; }
            getEmptyMessage() { return 'No User Waypoints defined (Press New or MENU)'; }
            onViewOpened() {
                activeUserWptPage = this;
                super.onViewOpened();
            }
            refreshRows() {
                const list = loadStoredUserWaypoints();
                this.rows = list.map(function (u) {
                    return { u: u, left: u.ident, right: formatDegMinCoord(u.lat, true) + ' ' + formatDegMinCoord(u.lon, false) };
                });
                if (this.selectedIdx >= this.rows.length) this.selectedIdx = Math.max(0, this.rows.length - 1);
                this.renderDomRows();
            }
            onRowEnter() {
                openCreateUserWaypointDialog();
                return true;
            }
            onRowClr(row) {
                if (!row || !row.u) return false;
                deletePersistedUserWaypoint(row.u.ident);
                this.refreshRows();
                return true;
            }
            onRowDirectTo(row) {
                if (!row || !row.u) return false;
                this.props.viewService.open('DirectTo').setInput({ icao: makeUserIcao(row.u.ident) });
                return true;
            }
            onMenuPressed() {
                openCreateUserWaypointDialog();
                return true;
            }
        }

        // 3. NRST – Nearest User WPTs (Item #13a)
        class MFDNearestUserWptsPage extends BaseCustomListMfdPage {
            constructor(props) {
                super(props);
                this._title.set('NRST \u2013 Nearest User Waypoints');
            }
            getListBoxTitle() { return 'Nearest User'; }
            getColHeaders() { return ['IDENTIFIER', 'BRG      DIS']; }
            getInfoBoxTitle() { return 'Information'; }
            getInfoBoxLines(cur) {
                if (!cur || !cur.u) {
                    return [['Comment', 'NONE WITHIN 200NM'], ['Latitude', '__\u00B0__.__\''], ['Longitude', '___\u00B0__.__\'']];
                }
                return [
                    ['Comment', cur.u.name || 'USER WAYPOINT'],
                    ['Latitude', formatDegMinCoord(cur.u.lat, true)],
                    ['Longitude', formatDegMinCoord(cur.u.lon, false)]
                ];
            }
            getBottomPrompt() { return 'Press FMS CRSR to select  •  D\u2192 for Direct-To'; }
            getEmptyMessage() { return 'NONE WITHIN 200 NM'; }
            refreshRows() {
                const pos = getPlaneCoordinates();
                const list = loadStoredUserWaypoints().map(function (u) {
                    const dNm = pos ? computeDistanceRad(pos.lat, pos.lon, u.lat, u.lon) * (180 / Math.PI) * 60 : 0;
                    const brg = pos ? Math.round(computeBearingDegTrue(pos.lat, pos.lon, u.lat, u.lon)) : 360;
                    return { u: u, dNm: dNm, brg: brg === 0 ? 360 : brg };
                }).filter(function (x) { return x.dNm <= 200; });
                list.sort(function (a, b) { return a.dNm - b.dNm; });
                this.rows = list.map(function (x) {
                    return { u: x.u, left: x.u.ident, right: String(x.brg).padStart(3, '0') + '\u00B0   ' + x.dNm.toFixed(1) + 'NM' };
                });
                this.renderDomRows();
            }
            onRowDirectTo(row) {
                if (!row || !row.u) return false;
                this.props.viewService.open('DirectTo').setInput({ icao: makeUserIcao(row.u.ident) });
                return true;
            }
        }

        // 4. NRST – Nearest Frequencies (ARTCC / Approach / Tower / CTAF / ATIS) (Item #13b)
        class MFDNearestFrequenciesPage extends BaseCustomListMfdPage {
            constructor(props) {
                super(props);
                this._title.set('NRST \u2013 Nearest Frequencies');
            }
            getListBoxTitle() { return 'Nearest Frequencies'; }
            getColHeaders() { return ['FACILITY / TYPE', 'FREQUENCY']; }
            getInfoBoxTitle() { return 'Selected Frequency'; }
            getInfoBoxLines(cur) {
                if (!cur || !cur.entry) {
                    return [['Facility', '______'], ['Distance', '--.- NM'], ['Action', 'Press ENT to tune COM Standby']];
                }
                return [
                    ['Facility', cur.entry.ident + (cur.entry.facName ? (' \u2014 ' + cur.entry.facName.substr(0, 18)) : '')],
                    ['Type / Dist', cur.entry.name + '  (' + cur.entry.dNm.toFixed(1) + ' NM)'],
                    ['Standby Tune', cur.entry.mhz.toFixed(3) + ' MHz  [Press ENT]']
                ];
            }
            getBottomPrompt() { return 'Press FMS CRSR & ENT to load into COM1 Standby'; }
            getEmptyMessage() { return 'Searching nearby frequencies...'; }
            onViewOpened() {
                const self = this;
                const FST = sdk.FacilitySearchType || {};
                if (FST.Airport !== undefined) {
                    refreshNearestForType(FST.Airport, null, false, function () {
                        self.refreshRows();
                    });
                }
                super.onViewOpened();
            }
            refreshRows() {
                const pos = getPlaneCoordinates();
                const entries = [];
                for (const fac of facilityDirectory.values()) {
                    if (!Array.isArray(fac.frequencies) || fac.frequencies.length === 0 || isNaN(fac.lat)) continue;
                    const dNm = pos ? computeDistanceRad(pos.lat, pos.lon, fac.lat, fac.lon) * (180 / Math.PI) * 60 : 0;
                    if (dNm > 100) continue;
                    for (let i = 0; i < fac.frequencies.length; i++) {
                        const fq = fac.frequencies[i];
                        if (!fq || typeof fq.freqMHz !== 'number' || fq.freqMHz < 118 || fq.freqMHz > 137) continue;
                        entries.push({
                            ident: fac.ident,
                            facName: fac.name || '',
                            name: cleanTranslatedStr(fq.name || 'COM'),
                            mhz: fq.freqMHz,
                            dNm: dNm
                        });
                    }
                }
                entries.sort(function (a, b) { return a.dNm - b.dNm; });
                safeSetSimVar('L:CT182T_DBG_NRST_FREQ_CNT', 'Number', entries.length);
                this.rows = entries.slice(0, 40).map(function (e) {
                    return {
                        mhz: e.mhz,
                        entry: e,
                        left: e.ident + '  ' + e.name.substr(0, 18),
                        right: e.mhz.toFixed(3)
                    };
                });
                this.renderDomRows();
            }
            onRowEnter(row) {
                if (!row || !row.mhz) return false;
                try {
                    const hz = Math.round(row.mhz * 1000000);
                    SimVar.SetSimVarValue('K:COM_STBY_RADIO_SET_HZ', 'Hz', hz);
                    safeSetSimVar('L:CT182T_DBG_TUNED_HZ', 'Number', hz);
                } catch (e) {}
                return true;
            }
        }

        // 5. AUX – GPS Status (Constellation, Satellite Status, WAAS/SBAS, RAIM Prediction, Signal Strength)
        let activeGpsStatusPage = null;
        let activeSystemStatusPage = null;
        if (mfdMod.SoftKeyMenu && typeof pluginMenuSystem.addMenu === 'function') {
            const gpsMenu = new mfdMod.SoftKeyMenu(pluginMenuSystem);
            gpsMenu.addItem(0, 'Engine', function () { pluginMenuSystem.pushMenu('engine-menu'); });
            gpsMenu.addItem(2, 'GPS1', function () {
                if (activeGpsStatusPage) activeGpsStatusPage.selectReceiver(1);
            }, true);
            gpsMenu.addItem(3, 'GPS2', function () {
                if (activeGpsStatusPage) activeGpsStatusPage.selectReceiver(2);
            }, false);
            gpsMenu.addItem(5, 'RAIM', function () {
                if (activeGpsStatusPage) activeGpsStatusPage.selectRightMode('raim');
            }, true);
            gpsMenu.addItem(6, 'SBAS', function () {
                if (activeGpsStatusPage) activeGpsStatusPage.selectRightMode('sbas');
            }, false);
            gpsMenu.addItem(11, 'Checklist', function () {}, undefined, true);
            pluginMenuSystem.addMenu('wt-gps-status-menu', gpsMenu);

            const sysMenu = new mfdMod.SoftKeyMenu(pluginMenuSystem);
            sysMenu.addItem(0, 'Engine', function () { pluginMenuSystem.pushMenu('engine-menu'); });
            sysMenu.addItem(2, 'LRU', function () {
                if (activeSystemStatusPage) activeSystemStatusPage.selectSection('lru');
            }, false);
            sysMenu.addItem(3, 'ARFRM', function () {
                if (activeSystemStatusPage) activeSystemStatusPage.selectSection('arfrm');
            }, false);
            sysMenu.addItem(4, 'MFD1 DB', function () {
                if (activeSystemStatusPage) activeSystemStatusPage.toggleDatabaseSoftkey();
            }, false);
            sysMenu.addItem(7, 'ANN Test', function () {
                if (activeSystemStatusPage) activeSystemStatusPage.triggerAnnTest();
            }, false);
            sysMenu.addItem(11, 'Checklist', function () {}, undefined, true);
            pluginMenuSystem.addMenu('wt-system-status-menu', sysMenu);
        }

        const BASE_GPS_SATELLITES = [
            { prn: '002', az: 354, el: 56, snr1: 84, snr2: 80, locked: true, waas: false },
            { prn: '005', az: 52,  el: 67, snr1: 91, snr2: 88, locked: true, waas: false },
            { prn: '007', az: 110, el: 39, snr1: 76, snr2: 79, locked: true, waas: false },
            { prn: '008', az: 146, el: 18, snr1: 48, snr2: 52, locked: false, waas: false },
            { prn: '010', az: 186, el: 62, snr1: 89, snr2: 85, locked: true, waas: false },
            { prn: '012', az: 224, el: 45, snr1: 80, snr2: 83, locked: true, waas: false },
            { prn: '013', az: 268, el: 74, snr1: 95, snr2: 92, locked: true, waas: false },
            { prn: '015', az: 306, el: 52, snr1: 87, snr2: 90, locked: true, waas: false },
            { prn: '018', az: 28,  el: 27, snr1: 70, snr2: 74, locked: true, waas: false },
            { prn: '020', az: 84,  el: 78, snr1: 93, snr2: 96, locked: true, waas: false },
            { prn: '024', az: 245, el: 25, snr1: 67, snr2: 70, locked: true, waas: false },
            { prn: '029', az: 328, el: 32, snr1: 77, snr2: 74, locked: true, waas: false },
            { prn: '131', az: 206, el: 33, snr1: 85, snr2: 83, locked: true, waas: true },
            { prn: '135', az: 192, el: 36, snr1: 88, snr2: 87, locked: true, waas: true },
            { prn: '138', az: 164, el: 30, snr1: 82, snr2: 84, locked: true, waas: true }
        ];

        const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

        class MFDGpsStatusPage extends mfdMod.MFDUiPage {
            constructor(props) {
                super(props);
                this._title.set('Aux \u2013 GPS Status');
                this.contentRef = sdk.FSComponent.createRef();
                this.selectedRx = 1; // 1 = GPS1, 2 = GPS2
                this.rightMode = 'raim'; // 'raim' | 'sbas'
                this.focusedField = 0; // RAIM: 0=WPT, 1=ARV Time, 2=ARV Date, 3=Compute RAIM?; SBAS: 0=EGNOS, 1=MSAS, 2=WAAS
                this.raimWptIdent = '';
                this.raimMinOffset = 15;
                this.raimDayOffset = 0;
                this.raimState = 0; // 0=Compute RAIM?, 1=Computing Availability, 2=RAIM Available, 3=RAIM Not Available
                this.egnosEnabled = true;
                this.msasEnabled = true;
                this.waasEnabled = true; // Always true per training spec unless external L:CT182T_FAIL_WAAS == 1
                this._tickTimer = null;
                this._raimTimer = null;
            }
            syncSoftkeys() {
                try {
                    const m = pluginMenuSystem && (typeof pluginMenuSystem.getMenu === 'function'
                        ? pluginMenuSystem.getMenu('wt-gps-status-menu')
                        : (pluginMenuSystem.registeredMenus && pluginMenuSystem.registeredMenus['wt-gps-status-menu']));
                    if (!m || typeof m.getItem !== 'function') return;
                    if (m.getItem(2) && m.getItem(2).value) m.getItem(2).value.set(this.selectedRx === 1);
                    if (m.getItem(3) && m.getItem(3).value) m.getItem(3).value.set(this.selectedRx === 2);
                    if (m.getItem(5) && m.getItem(5).value) m.getItem(5).value.set(this.rightMode === 'raim');
                    if (m.getItem(6) && m.getItem(6).value) m.getItem(6).value.set(this.rightMode === 'sbas');
                } catch (e) {}
            }
            selectReceiver(rx) {
                this.selectedRx = rx === 2 ? 2 : 1;
                this.syncSoftkeys();
                this.renderGpsDom();
            }
            selectRightMode(mode) {
                this.rightMode = mode === 'sbas' ? 'sbas' : 'raim';
                this.focusedField = 0;
                this.syncSoftkeys();
                this.renderGpsDom();
            }
            ensureDefaultRaimWaypoint() {
                if (this.raimWptIdent) return;
                try {
                    if (submenuFms && typeof submenuFms.hasPrimaryFlightPlan === 'function' && submenuFms.hasPrimaryFlightPlan()) {
                        const plan = submenuFms.getPrimaryFlightPlan();
                        if (plan.destinationAirport) {
                            this.raimWptIdent = sdk.ICAO.getIdent(plan.destinationAirport).trim();
                            return;
                        }
                        for (let g = plan.length - 1; g >= 0; g--) {
                            const ld = plan.tryGetLeg(g);
                            if (ld && ld.leg && isSelectableWaypointIcao(ld.leg.fixIcao)) {
                                this.raimWptIdent = sdk.ICAO.getIdent(ld.leg.fixIcao).trim();
                                return;
                            }
                        }
                    }
                    const FST = sdk.FacilitySearchType || {};
                    const aptSess = nearestSessions.get(FST.Airport !== undefined ? FST.Airport : 1);
                    if (aptSess && aptSess.sortedItems && aptSess.sortedItems.length > 0) {
                        this.raimWptIdent = aptSess.sortedItems[0].ident;
                        return;
                    }
                } catch (e) {}
                this.raimWptIdent = 'KPAE';
            }
            onViewOpened() {
                super.onViewOpened();
                activeGpsStatusPage = this;
                this.props.viewService.clearPageHistory();
                this.props.menuSystem.clear();
                this.props.menuSystem.pushMenu('wt-gps-status-menu');
                this.setScrollEnabled(false);
                this.ensureDefaultRaimWaypoint();
                this.syncSoftkeys();
                this.renderGpsDom();
                const self = this;
                if (this._tickTimer) clearInterval(this._tickTimer);
                if (typeof setInterval === 'function') {
                    this._tickTimer = setInterval(function () {
                        if (submenuViewService && submenuViewService.openPageKey.get() === 'GPSStatusPage') {
                            self.renderGpsDom();
                        }
                    }, 1000);
                }
            }
            onViewClosed() {
                super.onViewClosed();
                this.setScrollEnabled(false);
                if (this._tickTimer) {
                    clearInterval(this._tickTimer);
                    this._tickTimer = null;
                }
                if (this._raimTimer) {
                    clearTimeout(this._raimTimer);
                    this._raimTimer = null;
                }
            }
            triggerRaimCheck() {
                const self = this;
                if (this._raimTimer) clearTimeout(this._raimTimer);
                this.raimState = 1; // Computing Availability
                safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 1);
                this.renderGpsDom();
                if (typeof setTimeout === 'function') {
                    this._raimTimer = setTimeout(function () {
                        self._raimTimer = null;
                        let failRaim = 0;
                        try {
                            const eff = typeof computeEffectiveAvionicsFailureState === 'function' ? computeEffectiveAvionicsFailureState() : null;
                            if (eff) {
                                failRaim = (eff.raimFail || eff.gpsBothFail) ? 1 : 0;
                            } else {
                                failRaim = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_RAIM', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_RAIM', 'Number') || 0);
                            }
                        } catch (e) {}
                        self.raimState = failRaim > 0 ? 3 : 2; // Always 2 ('RAIM Available') unless external failure injected
                        safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', self.raimState);
                        self.renderGpsDom();
                    }, 350);
                } else {
                    this.raimState = 2;
                    safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 2);
                    this.renderGpsDom();
                }
            }
            openRaimWaypointPicker(openSubmenu) {
                const self = this;
                if (!this.props.viewService) return false;
                if (openSubmenu) autoOpenSubmenuUntil = Date.now() + 800;
                const wptDlg = this.props.viewService.open('WptInfo', true);
                if (wptDlg && wptDlg.onAccept) {
                    wptDlg.onAccept.on(function (sender, fac) {
                        if (fac && fac.icao) {
                            self.raimWptIdent = sdk.ICAO.getIdent(fac.icao).trim();
                            self.raimState = 0;
                            safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 0);
                            self.focusedField = 1; // Advance to ARV Time
                            self.renderGpsDom();
                        }
                    });
                }
                return true;
            }
            onMenuPressed() {
                const self = this;
                const otherRx = self.selectedRx === 1 ? 2 : 1;
                const dlg = self.props.viewService.open('PageMenuDialog', true);
                dlg.setMenuItems([
                    {
                        id: 'gps-switch-rx',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Select GPS ' + otherRx); },
                        isEnabled: true,
                        action: function () { self.selectReceiver(otherRx); }
                    },
                    {
                        id: 'gps-raim-ppos',
                        renderContent: function () { return sdk.FSComponent.buildComponent('span', null, 'Set WPT to Present Position'); },
                        isEnabled: self.rightMode === 'raim',
                        action: function () {
                            self.raimWptIdent = 'PPOS';
                            self.raimState = 0;
                            safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 0);
                            self.setScrollEnabled(true);
                            self.focusedField = 3; // Ready on Compute RAIM?
                            self.renderGpsDom();
                        }
                    }
                ]);
                return true;
            }
            processHEvent(evt) {
                if (evt === mfdMod.FmsHEvent.UPPER_PUSH) {
                    this.toggleScroll();
                    if (this.scrollController.getIsScrollEnabled() && this.rightMode === 'raim') {
                        this.focusedField = 0;
                    }
                    this.renderGpsDom();
                    return true;
                }
                if (evt === mfdMod.FmsHEvent.MENU) {
                    return this.onMenuPressed();
                }
                if (this.scrollController.getIsScrollEnabled()) {
                    const maxIdx = this.rightMode === 'raim' ? 3 : 2;
                    if (evt === mfdMod.FmsHEvent.LOWER_INC) {
                        this.focusedField = Math.min(maxIdx, this.focusedField + 1);
                        this.renderGpsDom();
                        return true;
                    }
                    if (evt === mfdMod.FmsHEvent.LOWER_DEC) {
                        this.focusedField = Math.max(0, this.focusedField - 1);
                        this.renderGpsDom();
                        return true;
                    }
                    if (this.rightMode === 'raim') {
                        if (this.focusedField === 0 && (evt === mfdMod.FmsHEvent.UPPER_INC || evt === mfdMod.FmsHEvent.UPPER_DEC)) {
                            return this.openRaimWaypointPicker(evt === mfdMod.FmsHEvent.UPPER_DEC);
                        }
                        if (this.focusedField === 1 && (evt === mfdMod.FmsHEvent.UPPER_INC || evt === mfdMod.FmsHEvent.UPPER_DEC)) {
                            this.raimMinOffset += (evt === mfdMod.FmsHEvent.UPPER_INC ? 15 : -15);
                            this.raimState = 0;
                            safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 0);
                            this.renderGpsDom();
                            return true;
                        }
                        if (this.focusedField === 2 && (evt === mfdMod.FmsHEvent.UPPER_INC || evt === mfdMod.FmsHEvent.UPPER_DEC)) {
                            this.raimDayOffset = Math.max(-30, Math.min(365, this.raimDayOffset + (evt === mfdMod.FmsHEvent.UPPER_INC ? 1 : -1)));
                            this.raimState = 0;
                            safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', 0);
                            this.renderGpsDom();
                            return true;
                        }
                        if (evt === mfdMod.FmsHEvent.CLR) {
                            if (this.focusedField === 1 && this.raimMinOffset !== 15) {
                                this.raimMinOffset = 15;
                                this.raimState = 0;
                                this.renderGpsDom();
                                return true;
                            }
                            if (this.focusedField === 2 && this.raimDayOffset !== 0) {
                                this.raimDayOffset = 0;
                                this.raimState = 0;
                                this.renderGpsDom();
                                return true;
                            }
                            this.setScrollEnabled(false);
                            this.renderGpsDom();
                            return true;
                        }
                        if (evt === mfdMod.FmsHEvent.ENT) {
                            if (this.focusedField < 3) {
                                this.focusedField++;
                                this.renderGpsDom();
                            } else {
                                this.triggerRaimCheck();
                            }
                            return true;
                        }
                    } else {
                        // SBAS Selection mode: EGNOS (0), MSAS (1), WAAS (2 — locked true unless external fail)
                        if (evt === mfdMod.FmsHEvent.ENT) {
                            if (this.focusedField === 0) this.egnosEnabled = !this.egnosEnabled;
                            else if (this.focusedField === 1) this.msasEnabled = !this.msasEnabled;
                            else if (this.focusedField === 2) this.waasEnabled = true; // WAAS always true per training spec
                            this.renderGpsDom();
                            return true;
                        }
                        if (evt === mfdMod.FmsHEvent.CLR) {
                            this.setScrollEnabled(false);
                            this.renderGpsDom();
                            return true;
                        }
                    }
                }
                return super.processHEvent(evt);
            }
            renderGpsDom() {
                ensureCustomModalDom();
                const el = this.contentRef.instance;
                if (!el) return;

                let lat = 47.9063;
                let lon = -122.2815;
                let zuluSec = 43200;
                let zDay = 17;
                let zMonth = 11;
                let zYear = 2026;
                let altFt = 140;
                let gsKts = 0;
                let trkDeg = 360;
                let failGps1 = 0;
                let failGps2 = 0;
                let failWaas = 0;
                try {
                    if (typeof SimVar !== 'undefined') {
                        const pLat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees'));
                        const pLon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees'));
                        if (!isNaN(pLat) && !isNaN(pLon) && !(pLat === 0 && pLon === 0)) {
                            lat = pLat;
                            lon = pLon;
                        }
                        const zs = Number(SimVar.GetSimVarValue('ZULU TIME', 'seconds'));
                        if (!isNaN(zs) && zs >= 0) zuluSec = zs;
                        const zd = Number(SimVar.GetSimVarValue('ZULU DAY OF MONTH', 'number'));
                        const zm = Number(SimVar.GetSimVarValue('ZULU MONTH OF YEAR', 'number'));
                        const zy = Number(SimVar.GetSimVarValue('ZULU YEAR', 'number'));
                        if (zd >= 1 && zd <= 31) zDay = Math.round(zd);
                        if (zm >= 1 && zm <= 12) zMonth = Math.round(zm);
                        if (zy >= 2000) zYear = Math.round(zy);
                        const pa = Number(SimVar.GetSimVarValue('PLANE ALTITUDE', 'feet'));
                        if (!isNaN(pa)) altFt = Math.round(pa);
                        const gs = Number(SimVar.GetSimVarValue('GPS GROUND SPEED', 'knots'));
                        if (!isNaN(gs) && gs >= 0) gsKts = gs;
                        const tk = Number(SimVar.GetSimVarValue('GPS GROUND MAGNETIC TRACK', 'degrees'));
                        const hd = Number(SimVar.GetSimVarValue('PLANE HEADING DEGREES MAGNETIC', 'degrees'));
                        const rawTrk = (gsKts > 2 && !isNaN(tk)) ? tk : hd;
                        if (!isNaN(rawTrk)) {
                            trkDeg = Math.round(((rawTrk % 360) + 360) % 360);
                            if (trkDeg === 0) trkDeg = 360;
                        }
                        const effGps = typeof computeEffectiveAvionicsFailureState === 'function' ? computeEffectiveAvionicsFailureState() : null;
                        if (effGps) {
                            failGps1 = effGps.gps1Fail ? 1 : 0;
                            failGps2 = effGps.gps2Fail ? 1 : 0;
                            failWaas = effGps.waasFail ? 1 : 0;
                        } else {
                            failGps1 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS1', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS1', 'Number') || 0);
                            failGps2 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS2', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS2', 'Number') || 0);
                            failWaas = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_WAAS', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_WAAS', 'Number') || 0);
                        }
                    }
                } catch (e) {}

                const rxFailed = (this.selectedRx === 1 && failGps1 > 0) || (this.selectedRx === 2 && failGps2 > 0);
                const waasActive = !rxFailed && failWaas <= 0 && this.waasEnabled;
                const navActiveGps = (failGps1 > 0 && failGps2 <= 0) ? 'GPS2' : ((failGps1 > 0 && failGps2 > 0) ? 'NONE' : 'GPS1');
                const gpsSolutionText = rxFailed ? 'ACQUIRING' : (waasActive ? '3D DIFF NAV' : '3D NAV');
                const sbasStatusText = rxFailed ? 'Inactive' : (waasActive ? 'Active' : 'Disabled');

                const driftDeg = ((zuluSec / 240) % 360) + (this.selectedRx === 2 ? 1.5 : 0);
                const shimmer = Math.round(Math.sin(zuluSec * 0.35 + this.selectedRx) * 1.5);
                let lockedCount = 0;
                const satData = [];
                for (let i = 0; i < BASE_GPS_SATELLITES.length; i++) {
                    const b = BASE_GPS_SATELLITES[i];
                    const az = (b.az + (b.waas ? 0 : driftDeg)) % 360;
                    const baseSnr = this.selectedRx === 1 ? b.snr1 : b.snr2;
                    const isSatLocked = !rxFailed && b.locked && (!b.waas || waasActive);
                    const snr = rxFailed ? 0 : ((!b.waas || waasActive) ? Math.max(12, Math.min(99, baseSnr + shimmer)) : 0);
                    if (isSatLocked) lockedCount++;
                    satData.push({
                        prn: b.prn,
                        az: az,
                        el: b.el,
                        snr: snr,
                        locked: isSatLocked,
                        diff: isSatLocked && waasActive,
                        collecting: !rxFailed && !isSatLocked && snr > 0
                    });
                }

                safeSetSimVar('L:CT182T_GPS_SELECTED_RX', 'Number', this.selectedRx);
                safeSetSimVar('L:CT182T_GPS_SAT_COUNT', 'Number', lockedCount);
                safeSetSimVar('L:CT182T_GPS_WAAS_ACTIVE', 'Number', waasActive ? 1 : 0);
                safeSetSimVar('L:CT182T_GPS_RAIM_STATE', 'Number', this.raimState);

                // Format UTC time & RAIM Arrival Time/Date
                const hh = String(Math.floor(zuluSec / 3600) % 24).padStart(2, '0');
                const mm = String(Math.floor((zuluSec % 3600) / 60)).padStart(2, '0');
                const ss = String(Math.floor(zuluSec % 60)).padStart(2, '0');
                const utcStr = hh + ':' + mm + ':' + ss + ' UTC';

                const arvTotalMin = ((Math.floor(zuluSec / 60) + this.raimMinOffset) % 1440 + 1440) % 1440;
                const arvHh = String(Math.floor(arvTotalMin / 60)).padStart(2, '0');
                const arvMm = String(arvTotalMin % 60).padStart(2, '0');
                const arvTimeStr = arvHh + ':' + arvMm + ' UTC';

                const baseDate = new Date(Date.UTC(zYear, zMonth - 1, zDay));
                baseDate.setUTCDate(baseDate.getUTCDate() + this.raimDayOffset);
                const arvDayStr = String(baseDate.getUTCDate()).padStart(2, '0') + '-' + MONTHS_SHORT[baseDate.getUTCMonth()] + '-' + String(baseDate.getUTCFullYear()).slice(-2);

                const cursorOn = this.scrollController.getIsScrollEnabled();

                // Build Skyview SVG (240 x 320 area inside Constellation box)
                const cx = 124;
                const cy = 176;
                const rOuter = 112;
                const rInner = 56;
                let skySvg = '<svg width="248" height="328" viewBox="0 0 248 328" style="display:block;margin:0 auto;">';
                skySvg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + rOuter + '" fill="none" stroke="rgb(138,146,158)" stroke-width="1.4"/>';
                skySvg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + rInner + '" fill="none" stroke="rgb(110,118,130)" stroke-width="1.1" stroke-dasharray="3,3"/>';
                skySvg += '<line x1="' + (cx - 5) + '" y1="' + cy + '" x2="' + (cx + 5) + '" y2="' + cy + '" stroke="rgb(150,158,170)" stroke-width="1.2"/>';
                skySvg += '<line x1="' + cx + '" y1="' + (cy - 5) + '" x2="' + cx + '" y2="' + (cy + 5) + '" stroke="rgb(150,158,170)" stroke-width="1.2"/>';
                skySvg += '<text x="' + cx + '" y="' + (cy - rOuter - 7) + '" fill="white" font-size="13" font-weight="bold" text-anchor="middle">N</text>';
                skySvg += '<text x="' + (cx + rOuter + 10) + '" y="' + (cy + 4) + '" fill="#b8c0cc" font-size="12" text-anchor="middle">E</text>';
                skySvg += '<text x="' + cx + '" y="' + (cy + rOuter + 15) + '" fill="#b8c0cc" font-size="12" text-anchor="middle">S</text>';
                skySvg += '<text x="' + (cx - rOuter - 10) + '" y="' + (cy + 4) + '" fill="#b8c0cc" font-size="12" text-anchor="middle">W</text>';

                for (let i = 0; i < satData.length; i++) {
                    const s = satData[i];
                    if (s.snr <= 0 && !rxFailed) continue;
                    const rad = ((s.az - 90) * Math.PI) / 180;
                    const dist = ((90 - Math.max(5, Math.min(90, s.el))) / 90) * rOuter;
                    const sx = Math.round(cx + Math.cos(rad) * dist);
                    const sy = Math.round(cy + Math.sin(rad) * dist);
                    const fillCol = s.locked ? '#28d838' : (s.collecting ? '#38d8f0' : 'none');
                    const strokeCol = s.locked ? '#28d838' : (s.collecting ? '#38d8f0' : '#8a94a4');
                    const txtCol = (s.locked || s.collecting) ? '#000000' : '#c8d0dc';
                    skySvg += '<rect x="' + (sx - 14) + '" y="' + (sy - 8) + '" width="28" height="16" rx="8" ry="8" fill="' + fillCol + '" stroke="' + strokeCol + '" stroke-width="1.3"/>';
                    skySvg += '<text x="' + sx + '" y="' + (sy + 4) + '" fill="' + txtCol + '" font-size="10.5" font-weight="bold" text-anchor="middle">' + s.prn + '</text>';
                }
                skySvg += '</svg>';

                // Build Signal Strength SVG (832 x 248 inside bottom GroupBox)
                let barSvg = '<svg width="832" height="248" viewBox="0 0 832 248" style="display:block;margin:2px auto 0 auto;">';
                const chartLeft = 18;
                const chartRight = 814;
                const chartTop = 14;
                const chartBot = 212;
                const chartH = chartBot - chartTop;
                for (let g = 0; g <= 4; g++) {
                    const gy = Math.round(chartTop + (chartH * g) / 4);
                    const dash = (g === 0 || g === 4) ? '' : ' stroke-dasharray="4,4"';
                    barSvg += '<line x1="' + chartLeft + '" y1="' + gy + '" x2="' + chartRight + '" y2="' + gy + '" stroke="rgb(105,112,122)" stroke-width="1"' + dash + '/>';
                }
                const slotW = (chartRight - chartLeft) / satData.length;
                const barW = 28;
                for (let i = 0; i < satData.length; i++) {
                    const s = satData[i];
                    const bx = Math.round(chartLeft + i * slotW + (slotW - barW) / 2);
                    const bh = Math.round((s.snr / 100) * chartH);
                    const by = chartBot - bh;
                    if (s.locked) {
                        barSvg += '<rect x="' + bx + '" y="' + by + '" width="' + barW + '" height="' + bh + '" fill="#28d838" stroke="#28d838" stroke-width="1"/>';
                        if (s.diff && bh >= 18) {
                            barSvg += '<text x="' + (bx + barW / 2) + '" y="' + (chartBot - 5) + '" fill="#000" font-size="13" font-weight="bold" text-anchor="middle">D</text>';
                        }
                    } else if (s.collecting && bh > 4) {
                        barSvg += '<rect x="' + bx + '" y="' + by + '" width="' + barW + '" height="' + bh + '" fill="#42dcf4" stroke="#42dcf4" stroke-width="1"/>';
                    } else {
                        barSvg += '<rect x="' + bx + '" y="' + (chartBot - 38) + '" width="' + barW + '" height="38" fill="none" stroke="rgb(115,122,132)" stroke-width="1" stroke-dasharray="2,2"/>';
                    }
                    barSvg += '<text x="' + (bx + barW / 2) + '" y="' + (chartBot + 20) + '" fill="whitesmoke" font-size="13" font-weight="bold" text-anchor="middle">' + s.prn + '</text>';
                }
                barSvg += '</svg>';

                const epuStr = rxFailed ? '--- NM' : (waasActive ? (this.selectedRx === 1 ? '0.02 NM' : '0.03 NM') : '0.08 NM');
                const hdopStr = rxFailed ? '-.-' : (this.selectedRx === 1 ? '0.7' : '0.8');
                const hfomStr = rxFailed ? '--- FT' : (waasActive ? (this.selectedRx === 1 ? '8 FT' : '9 FT') : '28 FT');
                const vfomStr = rxFailed ? '--- FT' : (waasActive ? (this.selectedRx === 1 ? '18 FT' : '21 FT') : '54 FT');
                const latStr = formatDegMinCoord(lat, true);
                const lonStr = formatDegMinCoord(lon, false);

                let lowerRightHtml = '';
                if (this.rightMode === 'raim') {
                    const f0 = (cursorOn && this.focusedField === 0) ? ' wt-selected' : '';
                    const f1 = (cursorOn && this.focusedField === 1) ? ' wt-selected' : '';
                    const f2 = (cursorOn && this.focusedField === 2) ? ' wt-selected' : '';
                    const f3 = (cursorOn && this.focusedField === 3) ? ' wt-selected' : '';
                    let statusHtml = '';
                    if (this.raimState === 1) {
                        statusHtml = '<div class="wt-gps-raim-status" style="color:#f5d142;">Computing Availability</div>';
                    } else if (this.raimState === 2) {
                        statusHtml = '<div class="wt-gps-raim-status" style="color:#28e038;">RAIM Available</div>';
                    } else if (this.raimState === 3) {
                        statusHtml = '<div class="wt-gps-raim-status" style="color:#ff4444;">RAIM Not Available</div>';
                    } else {
                        statusHtml = '<div class="wt-gps-raim-status"></div>';
                    }
                    lowerRightHtml =
                        '<div class="wt-aux-gbox" style="height:234px;">' +
                          '<div class="wt-aux-gbox-title">RAIM Prediction</div>' +
                          '<div class="wt-aux-gbox-body">' +
                            '<div class="wt-gps-kv"><span>Waypoint</span><span class="wt-gps-edit' + f0 + '">' + (this.raimWptIdent || 'KPAE') + '</span></div>' +
                            '<div class="wt-gps-kv"><span>ARV Time</span><span class="wt-gps-edit' + f1 + '">' + arvTimeStr + '</span></div>' +
                            '<div class="wt-gps-kv"><span>ARV Date</span><span class="wt-gps-edit' + f2 + '">' + arvDayStr + '</span></div>' +
                            '<div class="wt-gps-raim-btn-wrap">' +
                              '<div class="wt-gps-raim-btn' + f3 + '">Compute RAIM?</div>' +
                              statusHtml +
                            '</div>' +
                          '</div>' +
                        '</div>';
                } else {
                    const s0 = (cursorOn && this.focusedField === 0) ? ' wt-selected' : '';
                    const s1 = (cursorOn && this.focusedField === 1) ? ' wt-selected' : '';
                    const s2 = (cursorOn && this.focusedField === 2) ? ' wt-selected' : '';
                    const chkWaas = (this.waasEnabled && failWaas <= 0);
                    lowerRightHtml =
                        '<div class="wt-aux-gbox" style="height:234px;">' +
                          '<div class="wt-aux-gbox-title">SBAS Selection</div>' +
                          '<div class="wt-aux-gbox-body" style="padding-top:16px;">' +
                            '<div class="wt-gps-sbas-row' + s0 + '"><span class="wt-gps-sbas-chk">' + (this.egnosEnabled ? '\u2714' : '') + '</span><span>EGNOS</span></div>' +
                            '<div class="wt-gps-sbas-row' + s1 + '"><span class="wt-gps-sbas-chk">' + (this.msasEnabled ? '\u2714' : '') + '</span><span>MSAS</span></div>' +
                            '<div class="wt-gps-sbas-row' + s2 + '"><span class="wt-gps-sbas-chk">' + (chkWaas ? '\u2714' : '') + '</span><span>WAAS</span></div>' +
                          '</div>' +
                        '</div>';
                }

                const solColor = rxFailed ? '#f5d142' : '#28e038';
                el.innerHTML =
                    '<div class="wt-gps-top-grid">' +
                      '<div class="wt-aux-gbox" style="height:372px;">' +
                        '<div class="wt-aux-gbox-title">Constellation</div>' +
                        '<div class="wt-aux-gbox-body">' +
                          '<div class="wt-gps-northup">North Up</div>' +
                          skySvg +
                        '</div>' +
                      '</div>' +
                      '<div class="wt-aux-gbox" style="height:372px;">' +
                        '<div class="wt-aux-gbox-title">Satellite Status (GPS' + this.selectedRx + ')</div>' +
                        '<div class="wt-aux-gbox-body">' +
                          '<div class="wt-gps-kv"><span>EPU</span><span>' + epuStr + '</span></div>' +
                          '<div class="wt-gps-kv"><span>HDOP</span><span>' + hdopStr + '</span></div>' +
                          '<div class="wt-gps-kv"><span>HFOM</span><span>' + hfomStr + '</span></div>' +
                          '<div class="wt-gps-kv"><span>VFOM</span><span>' + vfomStr + '</span></div>' +
                          '<div class="wt-gps-sep"></div>' +
                          '<div class="wt-gps-kv" style="height:44px;align-items:flex-start;padding-top:2px;">' +
                            '<span>Position</span>' +
                            '<span style="text-align:right;line-height:20px;">' + latStr + '<br/>' + lonStr + '</span>' +
                          '</div>' +
                          '<div class="wt-gps-kv"><span>Time</span><span>' + utcStr + '</span></div>' +
                          '<div class="wt-gps-kv"><span>ALT MSL</span><span>' + (rxFailed ? '----- FT' : (altFt + ' FT')) + '</span></div>' +
                          '<div class="wt-gps-kv"><span>Ground Speed</span><span>' + (rxFailed ? '---.- KT' : (gsKts.toFixed(1) + ' KT')) + '</span></div>' +
                          '<div class="wt-gps-kv"><span>Track</span><span>' + (rxFailed ? '---°' : (String(trkDeg).padStart(3, '0') + '\u00B0')) + '</span></div>' +
                        '</div>' +
                      '</div>' +
                      '<div class="wt-gps-right-col">' +
                        '<div class="wt-aux-gbox" style="height:130px;">' +
                          '<div class="wt-aux-gbox-title">GPS Status</div>' +
                          '<div class="wt-aux-gbox-body">' +
                            '<div class="wt-gps-kv"><span>Active GPS</span><span>' + navActiveGps + '</span></div>' +
                            '<div class="wt-gps-kv"><span>GPS Solution</span><span style="color:' + solColor + ';">' + gpsSolutionText + '</span></div>' +
                            '<div class="wt-gps-kv"><span>SBAS</span><span style="color:' + (waasActive ? '#28e038' : '#c8d0dc') + ';">' + sbasStatusText + '</span></div>' +
                          '</div>' +
                        '</div>' +
                        lowerRightHtml +
                      '</div>' +
                    '</div>' +
                    '<div class="wt-aux-gbox" style="height:288px;margin-top:6px;">' +
                      '<div class="wt-aux-gbox-title">GPS Signal Strength (GPS' + this.selectedRx + ')</div>' +
                      '<div class="wt-aux-gbox-body" style="padding:4px 6px;">' +
                        barSvg +
                      '</div>' +
                    '</div>';

                try {
                    if (typeof el.getBoundingClientRect === 'function') {
                        const r = el.getBoundingClientRect();
                        const ok = (r.top >= 48 && r.left >= 140 && r.width >= 860 && r.bottom <= 738 && el.scrollHeight <= el.clientHeight + 2) ? 1 : 0;
                        safeSetSimVar('L:CT182T_DBG_AUXPAGE_OK', 'Number', ok);
                    }
                } catch (e) {}
            }
            render() {
                return sdk.FSComponent.buildComponent('div', { ref: this.viewContainerRef, class: 'mfd-page' },
                    sdk.FSComponent.buildComponent('div', { ref: this.contentRef, class: 'wt-aux-fullpage' }));
            }
        }

        // 6. AUX – System Status (All LRUs Operational + Airframe + MFD1/PFD1 Databases + Future Failure Mask Hook)
        const SYSTEM_LRUS = [
            { name: 'COM1',       serial: '------------', ver: '8.20' },
            { name: 'COM2',       serial: '------------', ver: '8.20' },
            { name: 'GDC1',       serial: '27401882',     ver: '3.12' },
            { name: 'GDL69',      serial: '48102944',     ver: '5.10' },
            { name: 'GDU1 PFD1',  serial: '49208114',     ver: '2501.00' },
            { name: 'GDU2 MFD1',  serial: '49208199',     ver: '2501.00' },
            { name: 'GEA1',       serial: '46701637',     ver: '2.14' },
            { name: 'GIA1',       serial: '1HQ007944',    ver: '8.05.1' },
            { name: 'GIA2',       serial: '1HQ008012',    ver: '8.05.1' },
            { name: 'GMA1',       serial: '47305518',     ver: '4.04' },
            { name: 'GMU1',       serial: '46509231',     ver: '2.02' },
            { name: 'GPS1',       serial: '1HQ007944',    ver: '5.20', gpsRx: 1 },
            { name: 'GPS2',       serial: '1HQ008012',    ver: '5.20', gpsRx: 2 },
            { name: 'GRS1',       serial: '27401882',     ver: '3.12' },
            { name: 'GS1',        serial: '17107230',     ver: '4.04' },
            { name: 'GS2',        serial: '17106439',     ver: '4.04' },
            { name: 'GSA PTCH',   serial: '51204410',     ver: '2.40' },
            { name: 'GSA ROLL',   serial: '51204411',     ver: '2.40' },
            { name: 'GSA P-TRIM', serial: '51204412',     ver: '2.40' },
            { name: 'GTS800',     serial: '48903315',     ver: '2.21' },
            { name: 'GTX1',       serial: '49811206',     ver: '2.60' }
        ];

        function getSystemAirframeRows() {
            let airframeName = 'Cessna Nav III G1000';
            let cfgId = 'FC6B68C6';
            let sysId = '00F4G1000';
            try {
                if (typeof SimVar !== 'undefined') {
                    const title = String(SimVar.GetSimVarValue('TITLE', 'string') || '').trim();
                    const model = String(SimVar.GetSimVarValue('ATC MODEL', 'string') || '').trim();
                    const combined = title + ' ' + model;
                    if (/172|Skyhawk/i.test(combined)) {
                        airframeName = 'Cessna 172S Skyhawk';
                        cfgId = 'FC6B172S';
                        sysId = '00F4C172S';
                    } else if (/182|Skylane/i.test(combined)) {
                        airframeName = 'Cessna 182T Skylane';
                        cfgId = 'FC6B68C6';
                        sysId = '00F4C182T';
                    } else if (/208|Caravan/i.test(combined)) {
                        airframeName = 'Cessna 208B Caravan';
                        cfgId = 'FC6B208B';
                        sysId = '00F4C208B';
                    } else if (/G36|Bonanza/i.test(combined)) {
                        airframeName = 'Beechcraft Bonanza G36';
                        cfgId = 'FC6BBG36';
                        sysId = '00F4BG360';
                    } else if (/G58|Baron/i.test(combined)) {
                        airframeName = 'Beechcraft Baron G58';
                        cfgId = 'FC6BBG58';
                        sysId = '00F4BG580';
                    } else if (/DA62/i.test(combined)) {
                        airframeName = 'Diamond DA62';
                        cfgId = 'FC6BDA62';
                        sysId = '00F4DA620';
                    } else if (/DA40/i.test(combined)) {
                        airframeName = 'Diamond DA40 NG';
                        cfgId = 'FC6BDA40';
                        sysId = '00F4DA40N';
                    } else if (/SR22/i.test(combined)) {
                        airframeName = 'Cirrus SR22T';
                        cfgId = 'FC6BSR22';
                        sysId = '00F4SR22T';
                    } else if (title) {
                        airframeName = title.substr(0, 22);
                    }
                }
            } catch (e) {}
            return [
                ['Airframe', airframeName],
                ['SYS Software Version', '2501.00'],
                ['Configuration ID', cfgId],
                ['CRG Part Number', '190-02177-00'],
                ['System ID', sysId],
                ['IOI Part Number', '006-B2298-14']
            ];
        }

        const SYSTEM_DB_ENTRIES = [
            { title: 'Navigation \u2013 INTERNAL', lines: [['Region', 'WW-ADB2'], ['Cycle', '2611 (ACTIVE)'], ['Status', 'Verified / Current']] },
            { title: 'BASEMAP \u2013 INTERNAL',    lines: [['Region', 'WORLDWIDE'], ['Version', '5.12']] },
            { title: 'SAFETAXI \u2013 INTERNAL',   lines: [['Region', 'NORTH AMERICA'], ['Version', '26.10']] },
            { title: 'TERRAIN \u2013 SD CARD',     lines: [['Region', 'WORLDWIDE 9-ARCSEC'], ['Version', '20.04']] },
            { title: 'OBSTACLE \u2013 INTERNAL',   lines: [['Region', 'US / CANADA / EU'], ['Version', '26B2']] },
            { title: 'AIRPORT DIR \u2013 INTERNAL', lines: [['Region', 'AMERICAS'], ['Status', 'Active']] }
        ];

        class MFDSystemStatusPage extends mfdMod.MFDUiPage {
            constructor(props) {
                super(props);
                this._title.set('Aux \u2013 System Status');
                this.contentRef = sdk.FSComponent.createRef();
                this.activeSection = 'lru'; // 'lru' | 'arfrm' | 'db'
                this.dbDisplayTarget = 'MFD1'; // 'MFD1' | 'PFD1'
                this.lruIdx = 0;
                this.arfrmIdx = 0;
                this.dbIdx = 0;
                this.annTesting = false;
                this._tickTimer = null;
            }
            syncSoftkeys() {
                try {
                    const m = pluginMenuSystem && (typeof pluginMenuSystem.getMenu === 'function'
                        ? pluginMenuSystem.getMenu('wt-system-status-menu')
                        : (pluginMenuSystem.registeredMenus && pluginMenuSystem.registeredMenus['wt-system-status-menu']));
                    if (!m || typeof m.getItem !== 'function') return;
                    const curOn = this.scrollController.getIsScrollEnabled();
                    if (m.getItem(2) && m.getItem(2).value) m.getItem(2).value.set(curOn && this.activeSection === 'lru');
                    if (m.getItem(3) && m.getItem(3).value) m.getItem(3).value.set(curOn && this.activeSection === 'arfrm');
                    if (m.getItem(4)) {
                        if (m.getItem(4).label) m.getItem(4).label.set(this.dbDisplayTarget + ' DB');
                        if (m.getItem(4).value) m.getItem(4).value.set(curOn && this.activeSection === 'db');
                    }
                    if (m.getItem(7) && m.getItem(7).value) m.getItem(7).value.set(!!this.annTesting);
                } catch (e) {}
            }
            selectSection(sec) {
                if (this.scrollController.getIsScrollEnabled() && this.activeSection === sec) {
                    this.setScrollEnabled(false);
                } else {
                    this.activeSection = sec;
                    this.setScrollEnabled(true);
                }
                this.syncSoftkeys();
                this.renderSysDom();
            }
            toggleDatabaseSoftkey() {
                if (!this.scrollController.getIsScrollEnabled() || this.activeSection !== 'db') {
                    this.activeSection = 'db';
                    this.setScrollEnabled(true);
                } else {
                    this.dbDisplayTarget = this.dbDisplayTarget === 'MFD1' ? 'PFD1' : 'MFD1';
                }
                this.syncSoftkeys();
                this.renderSysDom();
            }
            triggerAnnTest() {
                const self = this;
                this.annTesting = true;
                this.syncSoftkeys();
                try {
                    if (submenuBus && typeof submenuBus.getPublisher === 'function') {
                        const pub = submenuBus.getPublisher();
                        pub.pub('alerts_push', {
                            key: 'wt-sys-ann-test',
                            title: 'ANN TEST',
                            message: 'System Annunciation Test OK.'
                        }, true, false);
                        if (typeof setTimeout === 'function') {
                            setTimeout(function () {
                                self.annTesting = false;
                                self.syncSoftkeys();
                                pub.pub('alerts_remove', 'wt-sys-ann-test', true, false);
                            }, 2000);
                        }
                    }
                } catch (e) {}
            }
            onViewOpened() {
                super.onViewOpened();
                activeSystemStatusPage = this;
                this.props.viewService.clearPageHistory();
                this.props.menuSystem.clear();
                this.props.menuSystem.pushMenu('wt-system-status-menu');
                this.setScrollEnabled(false);
                this.syncSoftkeys();
                this.renderSysDom();
                const self = this;
                if (this._tickTimer) clearInterval(this._tickTimer);
                if (typeof setInterval === 'function') {
                    this._tickTimer = setInterval(function () {
                        if (submenuViewService && submenuViewService.openPageKey.get() === 'SystemStatusPage') {
                            self.renderSysDom();
                        }
                    }, 1500);
                }
            }
            onViewClosed() {
                super.onViewClosed();
                this.setScrollEnabled(false);
                if (this._tickTimer) {
                    clearInterval(this._tickTimer);
                    this._tickTimer = null;
                }
            }
            processHEvent(evt) {
                if (evt === mfdMod.FmsHEvent.UPPER_PUSH) {
                    this.toggleScroll();
                    this.syncSoftkeys();
                    this.renderSysDom();
                    return true;
                }
                if (this.scrollController.getIsScrollEnabled()) {
                    const isInc = (evt === mfdMod.FmsHEvent.LOWER_INC || evt === mfdMod.FmsHEvent.UPPER_INC);
                    const isDec = (evt === mfdMod.FmsHEvent.LOWER_DEC || evt === mfdMod.FmsHEvent.UPPER_DEC);
                    if (isInc || isDec) {
                        const delta = isInc ? 1 : -1;
                        if (this.activeSection === 'lru') {
                            this.lruIdx = Math.max(0, Math.min(SYSTEM_LRUS.length - 1, this.lruIdx + delta));
                        } else if (this.activeSection === 'arfrm') {
                            const afRows = getSystemAirframeRows();
                            this.arfrmIdx = Math.max(0, Math.min(afRows.length - 1, this.arfrmIdx + delta));
                        } else {
                            this.dbIdx = Math.max(0, Math.min(SYSTEM_DB_ENTRIES.length - 1, this.dbIdx + delta));
                        }
                        this.renderSysDom();
                        return true;
                    }
                    if (evt === mfdMod.FmsHEvent.CLR) {
                        this.setScrollEnabled(false);
                        this.syncSoftkeys();
                        this.renderSysDom();
                        return true;
                    }
                }
                return super.processHEvent(evt);
            }
            renderSysDom() {
                ensureCustomModalDom();
                const el = this.contentRef.instance;
                if (!el) return;

                let failMask = 0;
                let failGps1 = 0;
                let failGps2 = 0;
                try {
                    const effSys = typeof computeEffectiveAvionicsFailureState === 'function' ? computeEffectiveAvionicsFailureState() : null;
                    if (effSys) {
                        failMask = effSys.effectiveLruMask;
                        failGps1 = effSys.gps1Fail ? 1 : 0;
                        failGps2 = effSys.gps2Fail ? 1 : 0;
                    } else if (typeof SimVar !== 'undefined') {
                        failMask = Math.round(Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_LRU_MASK', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_LRU_MASK', 'Number') || 0));
                        failGps1 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS1', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS1', 'Number') || 0);
                        failGps2 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS2', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS2', 'Number') || 0);
                    }
                } catch (e) {}

                let okCount = 0;
                const lruStates = [];
                for (let i = 0; i < SYSTEM_LRUS.length; i++) {
                    const item = SYSTEM_LRUS[i];
                    const bitFailed = (failMask & (1 << i)) !== 0;
                    const gpsFailed = (item.gpsRx === 1 && failGps1 > 0) || (item.gpsRx === 2 && failGps2 > 0);
                    const isOk = !bitFailed && !gpsFailed;
                    if (isOk) okCount++;
                    lruStates.push({ item: item, isOk: isOk });
                }
                safeSetSimVar('L:CT182T_SYS_LRU_OK_COUNT', 'Number', okCount);
                safeSetSimVar('L:CT182T_SYS_LRU_TOTAL', 'Number', SYSTEM_LRUS.length);

                const curOn = this.scrollController.getIsScrollEnabled();
                const visLruCount = 19;
                const lruStart = Math.max(0, Math.min(this.lruIdx - Math.floor(visLruCount / 2), Math.max(0, lruStates.length - visLruCount)));
                const lruEnd = Math.min(lruStates.length, lruStart + visLruCount);

                let lruRowsHtml = '';
                for (let i = lruStart; i < lruEnd; i++) {
                    const st = lruStates[i];
                    const sel = (curOn && this.activeSection === 'lru' && i === this.lruIdx) ? ' wt-selected' : '';
                    const iconHtml = st.isOk
                        ? '<span class="wt-sys-ok">\u2714</span>'
                        : '<span class="wt-sys-fail">\u2715</span>';
                    const serialStr = st.isOk ? st.item.serial : '------------';
                    const verStr = st.isOk ? st.item.ver : '------';
                    lruRowsHtml +=
                        '<div class="wt-sys-lru-row' + sel + '">' +
                          '<span>' + st.item.name + '</span>' +
                          iconHtml +
                          '<span>' + serialStr + '</span>' +
                          '<span style="text-align:right;">' + verStr + '</span>' +
                        '</div>';
                }

                let arfrmHtml = '';
                const afRows = getSystemAirframeRows();
                for (let i = 0; i < afRows.length; i++) {
                    const sel = (curOn && this.activeSection === 'arfrm' && i === this.arfrmIdx) ? ' style="background:cyan;color:#000;padding:0 4px;font-weight:bold;"' : '';
                    arfrmHtml +=
                        '<div class="wt-gps-kv"' + sel + '>' +
                          '<span' + (sel ? ' style="color:#000;"' : '') + '>' + afRows[i][0] + '</span>' +
                          '<span' + (sel ? ' style="color:#000;"' : '') + '>' + afRows[i][1] + '</span>' +
                        '</div>';
                }

                const visDbCount = 4;
                const dbStart = Math.max(0, Math.min(this.dbIdx - 1, Math.max(0, SYSTEM_DB_ENTRIES.length - visDbCount)));
                const dbEnd = Math.min(SYSTEM_DB_ENTRIES.length, dbStart + visDbCount);
                let dbHtml = '';
                for (let i = dbStart; i < dbEnd; i++) {
                    const d = SYSTEM_DB_ENTRIES[i];
                    const sel = (curOn && this.activeSection === 'db' && i === this.dbIdx) ? ' wt-selected' : '';
                    dbHtml += '<div class="wt-sys-db-item' + sel + '"><div class="wt-sys-db-title">' + d.title + '</div>';
                    for (let j = 0; j < d.lines.length; j++) {
                        dbHtml += '<div class="wt-sys-db-sub"><span>' + d.lines[j][0] + '</span><span>' + d.lines[j][1] + '</span></div>';
                    }
                    dbHtml += '</div>';
                }

                el.innerHTML =
                    '<div class="wt-sys-grid">' +
                      '<div class="wt-aux-gbox" style="height:668px;">' +
                        '<div class="wt-aux-gbox-title">LRU Information (' + okCount + '/' + SYSTEM_LRUS.length + ' OK)</div>' +
                        '<div class="wt-aux-gbox-body">' +
                          '<div class="wt-sys-lru-hdr"><span>LRU</span><span style="text-align:center;">Status</span><span>Serial Number</span><span style="text-align:right;">Version</span></div>' +
                          lruRowsHtml +
                        '</div>' +
                      '</div>' +
                      '<div class="wt-sys-right-col">' +
                        '<div class="wt-aux-gbox" style="height:200px;">' +
                          '<div class="wt-aux-gbox-title">Airframe</div>' +
                          '<div class="wt-aux-gbox-body">' +
                            arfrmHtml +
                          '</div>' +
                        '</div>' +
                        '<div class="wt-aux-gbox" style="height:458px;">' +
                          '<div class="wt-aux-gbox-title">' + this.dbDisplayTarget + ' Database</div>' +
                          '<div class="wt-aux-gbox-body" style="padding:8px 8px;">' +
                            dbHtml +
                          '</div>' +
                        '</div>' +
                      '</div>' +
                    '</div>';

                try {
                    if (typeof el.getBoundingClientRect === 'function') {
                        const r = el.getBoundingClientRect();
                        const ok = (r.top >= 48 && r.left >= 140 && r.width >= 860 && r.bottom <= 738 && el.scrollHeight <= el.clientHeight + 2) ? 1 : 0;
                        safeSetSimVar('L:CT182T_DBG_AUXPAGE_OK', 'Number', ok);
                    }
                } catch (e) {}
            }
            render() {
                return sdk.FSComponent.buildComponent('div', { ref: this.viewContainerRef, class: 'mfd-page' },
                    sdk.FSComponent.buildComponent('div', { ref: this.contentRef, class: 'wt-aux-fullpage' }));
            }
        }

        vs.registerView('FPLCatalogPage', function () {
            return sdk.FSComponent.buildComponent(MFDStoredFplCatalogPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
        vs.registerView('UserWptInfoPage', function () {
            return sdk.FSComponent.buildComponent(MFDUserWptInfoPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
        vs.registerView('NearestUserWptsPage', function () {
            return sdk.FSComponent.buildComponent(MFDNearestUserWptsPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
        vs.registerView('NearestFreqsPage', function () {
            return sdk.FSComponent.buildComponent(MFDNearestFrequenciesPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
        vs.registerView('GPSStatusPage', function () {
            return sdk.FSComponent.buildComponent(MFDGpsStatusPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
        vs.registerView('SystemStatusPage', function () {
            return sdk.FSComponent.buildComponent(MFDSystemStatusPage, { viewService: vs, bus: submenuBus, menuSystem: pluginMenuSystem });
        });
    }

    function applyPageSelectCatalogAndPages(pageSelectMenuSys) {
        if (!isMfdContext || !pageSelectMenuSys || typeof pageSelectMenuSys.getPageLists !== 'function') {
            return;
        }
        try {
            const lists = pageSelectMenuSys.getPageLists();
            for (let g = 0; g < lists.length; g++) {
                const grp = lists[g];
                if (!grp || !Array.isArray(grp.items)) continue;
                let hasLocalCatalog = false;
                let externalCatalogIdx = -1;
                for (let i = 0; i < grp.items.length; i++) {
                    const it = grp.items[i];
                    if (!it) continue;
                    if (it.key === 'FPLCatalogPage') {
                        hasLocalCatalog = true;
                    } else if (it.name === 'Flight Plan Catalog') {
                        if (!it.key) {
                            it.key = 'FPLCatalogPage';
                            hasLocalCatalog = true;
                        } else {
                            externalCatalogIdx = i; // e.g. Navigraph SimBrief FlightPlanCatalog
                        }
                    } else if (it.name === 'User WPT Information') {
                        it.key = 'UserWptInfoPage';
                    } else if (it.name === 'Nearest User WPTs') {
                        it.key = 'NearestUserWptsPage';
                    } else if (it.name === 'Nearest Frequencies') {
                        it.key = 'NearestFreqsPage';
                    } else if (it.name === 'GPS Status') {
                        it.key = 'GPSStatusPage';
                    } else if (it.name === 'System Status') {
                        it.key = 'SystemStatusPage';
                    }
                }
                if (externalCatalogIdx >= 0 && !hasLocalCatalog) {
                    grp.items.splice(externalCatalogIdx + 1, 0, { name: 'Stored FPL Catalog', key: 'FPLCatalogPage' });
                    if (typeof pageSelectMenuSys.setPageList === 'function') {
                        pageSelectMenuSys.setPageList(g, grp);
                    }
                }
            }
            if (typeof pageSelectMenuSys.compute === 'function') {
                pageSelectMenuSys.compute();
            } else if (pageSelectMenuSys.pageSelectView && typeof pageSelectMenuSys.pageSelectView.compute === 'function') {
                pageSelectMenuSys.pageSelectView.compute();
            }
        } catch (e) {}
    }

    function activateMediumPageSelectEntries(pageSelectMenuSys) {
        applyPageSelectCatalogAndPages(pageSelectMenuSys);
        Promise.resolve().then(function () { applyPageSelectCatalogAndPages(pageSelectMenuSys); });
        if (typeof setTimeout === 'function') {
            setTimeout(function () { applyPageSelectCatalogAndPages(pageSelectMenuSys); }, 0);
        }
    }

    function installMediumUsabilitySupport(binder) {
        if (shouldInstallG1000Enhancements) {
        patchMediumUsabilityUi();
    }
        if (!binder) return;
        restorePersistedUserWaypointsToRepo();
        if (binder.bus) {
            try {
                binder.bus.getSubscriber().on('wt_ct182t_user_fac_sync').handle(function (msg) {
                    if (msg && msg.ident && typeof msg.lat === 'number' && typeof msg.lon === 'number') {
                        registerUserFacilityInRepo(msg.ident, msg.lat, msg.lon, !!msg.isTemporary, msg.name || msg.ident, true);
                    }
                });
            } catch (e) {}
        }

        // Pre-warm nearby Airports, VORs & NDBs into facilityDirectory for Name/City search, Nearest Frequencies & Map Pointer snap
        if (binder.bus && typeof setTimeout === 'function') {
            setTimeout(function () {
                const FST = sdk.FacilitySearchType || {};
                if (FST.Airport !== undefined) refreshNearestForType(FST.Airport, null, true, null);
                if (FST.Vor !== undefined) refreshNearestForType(FST.Vor, null, true, null);
                if (FST.Ndb !== undefined) refreshNearestForType(FST.Ndb, null, true, null);
            }, 2500);
        }
        if (binder.bus && isMfdContext) {
            try {
                const sub = binder.bus.getSubscriber();
                const onFplEvt = function () {
                    if (typeof setTimeout === 'function') {
                        setTimeout(refreshWideFplPanel, 20);
                    } else {
                        refreshWideFplPanel();
                    }
                };
                sub.on('fplCalculated').handle(onFplEvt);
                sub.on('fplLegChange').handle(onFplEvt);
                sub.on('fplActiveLegChange').handle(onFplEvt);
                sub.on('fplSegmentChange').handle(onFplEvt);
            } catch (e) {}
            if (!wideFplTickTimer && typeof setInterval === 'function') {
                wideFplTickTimer = setInterval(function () {
                    if (submenuViewService && submenuViewService.openPageKey.get() === 'FPLPage') {
                        refreshWideFplPanel();
                    }
                }, 1000);
            }
        }
        if (binder.viewService) {
            registerMediumMfdPages(binder.viewService);
        }
        if (binder.pageSelectMenuSystem) {
            activateMediumPageSelectEntries(binder.pageSelectMenuSystem);
        }
    }

    if (shouldInstallG1000Enhancements) {
        patchMediumUsabilityUi();
    }

    // =========================================================================
    // 16. ALT Outer Knob Approach Stepdowns & Minimums Snapping (PFD & MFD)
    //     Garmin G1000 NXi Pilot's Guide (190-02177-00 Rev. A, p. 49)
    // =========================================================================

    function resolveActiveFmsForAltSnap() {
        if (submenuFms) {
            return submenuFms;
        }
        try {
            if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
                const mfdEl = document.querySelector('wtg1000-mfd');
                if (mfdEl && mfdEl.fms) {
                    return mfdEl.fms;
                }
                const pfdEl = document.querySelector('wtg1000-pfd');
                if (pfdEl && pfdEl.fms) {
                    return pfdEl.fms;
                }
            }
        } catch (e) {}
        return null;
    }

    function getActiveMinimumsStopFeet(fms) {
        try {
            if (typeof SimVar === 'undefined' || typeof SimVar.GetSimVarValue !== 'function') {
                return null;
            }
            const mode = Math.round(Number(SimVar.GetSimVarValue('L:WT_MINIMUMS_MODE', 'Number')) || 0);
            // 1 = BARO, 3 = TEMP_COMP_BARO
            if (mode === 1 || mode === 3) {
                const da = Number(SimVar.GetSimVarValue('DECISION ALTITUDE MSL', 'Feet'));
                if (isFinite(da) && da >= -1000 && da <= 50000 && Math.abs(da) > 0.5) {
                    return Math.round(da);
                }
            } else if (mode === 2) {
                // 2 = RA (Radio Altimeter DH -> convert to MSL using approach runway elevation)
                const dh = Number(SimVar.GetSimVarValue('DECISION HEIGHT', 'Feet'));
                if (isFinite(dh) && dh > 0 && dh <= 5000) {
                    let rwyElevM = null;
                    if (fms && fms.approachDetails && fms.approachDetails.runway
                        && typeof fms.approachDetails.runway.elevation === 'number'
                        && isFinite(fms.approachDetails.runway.elevation)) {
                        rwyElevM = fms.approachDetails.runway.elevation;
                    } else if (fms && typeof fms.hasPrimaryFlightPlan === 'function' && fms.hasPrimaryFlightPlan()) {
                        const plan = fms.getPrimaryFlightPlan();
                        if (plan && typeof plan.segmentsOfType === 'function') {
                            for (const seg of plan.segmentsOfType(sdk.FlightPlanSegmentType.Approach)) {
                                if (!seg || !Array.isArray(seg.legs)) continue;
                                for (let i = 0; i < seg.legs.length; i++) {
                                    const ld = seg.legs[i];
                                    const fixIcao = (ld && ld.leg && ld.leg.fixIcao) ? String(ld.leg.fixIcao) : '';
                                    const isRwy = (sdk.ICAO && typeof sdk.ICAO.getFacilityType === 'function' && sdk.FacilityType)
                                        ? (sdk.ICAO.getFacilityType(fixIcao) === sdk.FacilityType.RWY)
                                        : (fixIcao.charAt(0) === 'R');
                                    if (isRwy && ld.leg && typeof ld.leg.altitude1 === 'number' && isFinite(ld.leg.altitude1) && ld.leg.altitude1 > -400) {
                                        rwyElevM = ld.leg.altitude1 - 15.24;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (rwyElevM !== null && isFinite(rwyElevM)) {
                        const mslStop = Math.round(rwyElevM * 3.280839895 + dh);
                        if (mslStop >= -1000 && mslStop <= 50000) {
                            return mslStop;
                        }
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    function isAircraftOnOrNearApproach(fms, plan) {
        try {
            if (!plan || typeof plan.segmentsOfType !== 'function') {
                return false;
            }
            let apprSegCount = 0;
            const refCoords = [];
            for (const seg of plan.segmentsOfType(sdk.FlightPlanSegmentType.Approach)) {
                if (!seg || !Array.isArray(seg.legs) || seg.legs.length === 0) continue;
                apprSegCount++;
                for (let i = 0; i < seg.legs.length; i++) {
                    const ld = seg.legs[i];
                    if (ld && ld.calculated) {
                        if (typeof ld.calculated.endLat === 'number' && typeof ld.calculated.endLon === 'number'
                            && isFinite(ld.calculated.endLat) && isFinite(ld.calculated.endLon)) {
                            refCoords.push({ lat: ld.calculated.endLat, lon: ld.calculated.endLon });
                        } else if (typeof ld.calculated.startLat === 'number' && typeof ld.calculated.startLon === 'number'
                            && isFinite(ld.calculated.startLat) && isFinite(ld.calculated.startLon)) {
                            refCoords.push({ lat: ld.calculated.startLat, lon: ld.calculated.startLon });
                        }
                    }
                }
            }
            if (apprSegCount === 0) {
                return false;
            }
            if (fms && fms.approachDetails && fms.approachDetails.isActive) {
                return true;
            }
            if (typeof SimVar !== 'undefined' && typeof SimVar.GetSimVarValue === 'function') {
                if (SimVar.GetSimVarValue('L:WTGarmin_Approach_Active', 'Bool')) {
                    return true;
                }
            }
            const activeIdx = plan.activeLateralLeg;
            if (typeof activeIdx === 'number' && activeIdx >= 0 && activeIdx < plan.length && typeof plan.getSegmentIndex === 'function') {
                const segIdx = plan.getSegmentIndex(activeIdx);
                if (segIdx >= 0) {
                    const activeSeg = typeof plan.tryGetSegment === 'function' ? plan.tryGetSegment(segIdx) : plan.getSegment(segIdx);
                    if (activeSeg && (activeSeg.segmentType === sdk.FlightPlanSegmentType.Approach
                        || activeSeg.segmentType === sdk.FlightPlanSegmentType.Arrival)) {
                        return true;
                    }
                }
            }
            if (refCoords.length === 0) {
                return true;
            }
            let lat = planeLat;
            let lon = planeLon;
            if ((!isFinite(lat) || !isFinite(lon)) && typeof SimVar !== 'undefined' && typeof SimVar.GetSimVarValue === 'function') {
                lat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees'));
                lon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees'));
            }
            if (!isFinite(lat) || !isFinite(lon) || (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001)) {
                return true;
            }
            if (sdk.GeoPoint && typeof sdk.GeoPoint.distance === 'function' && sdk.UnitType) {
                for (let i = 0; i < refCoords.length; i++) {
                    const distGa = sdk.GeoPoint.distance(lat, lon, refCoords[i].lat, refCoords[i].lon);
                    const distNm = sdk.UnitType.GA_RADIAN.convertTo(distGa, sdk.UnitType.NMILE);
                    if (isFinite(distNm) && distNm <= 40) {
                        return true;
                    }
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function collectApproachStepdownStopsFeet(fms) {
        const out = [];
        try {
            if (!fms || typeof fms.hasPrimaryFlightPlan !== 'function' || !fms.hasPrimaryFlightPlan()) {
                return out;
            }
            const plan = fms.getPrimaryFlightPlan();
            if (!isAircraftOnOrNearApproach(fms, plan)) {
                return out;
            }
            const Lt = sdk.LegType || {};
            const Art = sdk.AltitudeRestrictionType || {};
            const Unused = Art.Unused !== undefined ? Art.Unused : 0;
            const Between = Art.Between !== undefined ? Art.Between : 4;
            const missedFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.MissedApproach) ? sdk.LegDefinitionFlags.MissedApproach : 2;
            const seen = new Set();

            const addMetersAsFeet = function (meters) {
                if (typeof meters !== 'number' || !isFinite(meters) || meters <= -400) {
                    return;
                }
                const ft = Math.round(sdk.UnitType.METER.convertTo(meters, sdk.UnitType.FOOT));
                if (ft === 0 && Math.abs(meters) < 0.01) {
                    return;
                }
                if (ft >= -1000 && ft <= 50000 && !seen.has(ft)) {
                    seen.add(ft);
                    out.push(ft);
                }
            };

            for (const seg of plan.segmentsOfType(sdk.FlightPlanSegmentType.Approach)) {
                if (!seg || !Array.isArray(seg.legs)) continue;
                for (let i = 0; i < seg.legs.length; i++) {
                    const legDef = seg.legs[i];
                    if (!legDef || !legDef.leg) continue;
                    const lType = legDef.leg.type;
                    if (lType === Lt.Discontinuity || lType === Lt.ThruDiscontinuity) continue;

                    const isMissed = ((legDef.flags || 0) & missedFlag) === missedFlag;
                    const fixIcao = legDef.leg.fixIcao ? String(legDef.leg.fixIcao) : '';
                    const isRwyFac = fixIcao.charAt(0) === 'R';
                    const isRwyName = !!(legDef.name && /^RW\d{1,2}[LCRW]?$/i.test(String(legDef.name).trim()));
                    // Skip runway threshold TCH leg (rwyElev + 50 ft); Minimums provides the MDA/DA stop
                    if (!isMissed && (isRwyFac || isRwyName)) {
                        continue;
                    }
                    // Skip initial missed-approach 400-ft-AGL turn-trigger leg (CA/VA/FA) when followed by a higher missed-approach climb altitude
                    if (isMissed && (lType === Lt.CA || lType === Lt.VA || lType === Lt.FA)) {
                        const curHasVd = legDef.verticalData && legDef.verticalData.altDesc !== undefined && legDef.verticalData.altDesc !== Unused;
                        const curM = curHasVd ? legDef.verticalData.altitude1 : (legDef.leg.altitude1 || 0);
                        let hasHigherMissed = false;
                        for (let k = i + 1; k < seg.legs.length; k++) {
                            const nxt = seg.legs[k];
                            if (!nxt || !nxt.leg || (((nxt.flags || 0) & missedFlag) !== missedFlag)) continue;
                            const nxtHasVd = nxt.verticalData && nxt.verticalData.altDesc !== undefined && nxt.verticalData.altDesc !== Unused;
                            const nxtM = nxtHasVd ? nxt.verticalData.altitude1 : (nxt.leg.altitude1 || 0);
                            if (nxtM > curM + 10) {
                                hasHigherMissed = true;
                                break;
                            }
                        }
                        if (hasHigherMissed) {
                            continue;
                        }
                    }

                    let altDesc = Unused;
                    let a1 = 0;
                    let a2 = 0;
                    if (legDef.verticalData && legDef.verticalData.altDesc !== undefined && legDef.verticalData.altDesc !== Unused) {
                        altDesc = legDef.verticalData.altDesc;
                        a1 = legDef.verticalData.altitude1;
                        a2 = legDef.verticalData.altitude2;
                    } else if (legDef.leg.altDesc !== undefined && legDef.leg.altDesc !== Unused) {
                        altDesc = legDef.leg.altDesc;
                        a1 = legDef.leg.altitude1;
                        a2 = legDef.leg.altitude2;
                    }

                    if (altDesc !== Unused) {
                        addMetersAsFeet(a1);
                        if (altDesc === Between) {
                            addMetersAsFeet(a2);
                        }
                    }
                }
            }
            out.sort(function (a, b) { return a - b; });
        } catch (e) {}
        return out;
    }

    function installAltOuterKnobApproachSnap() {
        try {
            if (!sdk || !sdk.AltitudeSelectManager || !sdk.AltitudeSelectManager.prototype) {
                return;
            }
            const proto = sdk.AltitudeSelectManager.prototype;
            if (proto.__wtg1000AltSnapPatched) {
                return;
            }
            const origChangeSelectedAltitude = proto.changeSelectedAltitude;
            if (typeof origChangeSelectedAltitude !== 'function') {
                return;
            }
            proto.__wtg1000AltSnapPatched = true;

            proto.changeSelectedAltitude = function (startValue, direction, useLargeIncrement) {
                if (useLargeIncrement === undefined) {
                    useLargeIncrement = false;
                }
                const isMetric = !!(this.altimeterMetricSetting && this.altimeterMetricSetting.value === true);
                if (isMetric) {
                    return origChangeSelectedAltitude.call(this, startValue, direction, useLargeIncrement);
                }

                const fms = resolveActiveFmsForAltSnap();
                const minStop = getActiveMinimumsStopFeet(fms);
                const apprStops = collectApproachStepdownStopsFeet(fms);
                safeSetSimVar('L:WTG1000_ALT_STOP_COUNT', 'Number', apprStops.length + (minStop !== null ? 1 : 0));

                const stopSet = new Set();
                if (this.stops && typeof this.stops.peek === 'function' && this.stops.length > 0) {
                    for (let i = 0; i < this.stops.length; i++) {
                        const s = this.stops.peek(i);
                        if (typeof s === 'number' && isFinite(s)) {
                            stopSet.add(Math.round(s));
                        }
                    }
                }
                if (minStop !== null) {
                    stopSet.add(minStop);
                }
                if (useLargeIncrement) {
                    for (let i = 0; i < apprStops.length; i++) {
                        stopSet.add(apprStops[i]);
                    }
                }

                const min = typeof this.minValue === 'number' ? this.minValue : -1000;
                const max = typeof this.maxValue === 'number' ? this.maxValue : 50000;
                const incrSmall = typeof this.incrSmall === 'number' && this.incrSmall > 0 ? this.incrSmall : 100;
                const incrLarge = typeof this.incrLarge === 'number' && this.incrLarge > 0 ? this.incrLarge : 1000;
                const lockAlt = this.lockAltToStepOnIncr !== false;
                const sv = Math.round(startValue);

                let gridTarget;
                if (useLargeIncrement) {
                    // Never downgrade outer-knob (1000-ft) rotation to 100-ft when sitting on a non-100-multiple MDA/stepdown.
                    // When on/near an approach (or stepping off a non-100 stop), align baseline to 1000-ft multiples interleaved with stops.
                    if (apprStops.length > 0 || (minStop !== null && Math.abs(sv - minStop) < 1) || (lockAlt && (sv % incrSmall !== 0))) {
                        gridTarget = direction === 1
                            ? (Math.ceil((sv + 1) / incrLarge) * incrLarge)
                            : (Math.floor((sv - 1) / incrLarge) * incrLarge);
                    } else {
                        gridTarget = sv + direction * incrLarge;
                    }
                } else {
                    const roundFunc = direction === 1 ? Math.floor : Math.ceil;
                    const base = lockAlt ? (roundFunc(sv / incrSmall) * incrSmall) : sv;
                    gridTarget = base + direction * incrSmall;
                }

                if (stopSet.size > 0) {
                    let bestStop = null;
                    stopSet.forEach(function (s) {
                        if (direction === 1) {
                            if (s > startValue + 0.5 && (bestStop === null || s < bestStop)) {
                                bestStop = s;
                            }
                        } else if (direction === -1) {
                            if (s < startValue - 0.5 && (bestStop === null || s > bestStop)) {
                                bestStop = s;
                            }
                        }
                    });
                    if (bestStop !== null) {
                        if (direction === 1 && bestStop < gridTarget) {
                            gridTarget = bestStop;
                        } else if (direction === -1 && bestStop > gridTarget) {
                            gridTarget = bestStop;
                        }
                    }
                }

                const valueToSet = sdk.MathUtils ? sdk.MathUtils.clamp(gridTarget, min, max) : Math.max(min, Math.min(max, gridTarget));
                const simVarName = this.altitudeHoldSlotSimVar || 'AUTOPILOT ALTITUDE LOCK VAR:1';
                if (valueToSet !== SimVar.GetSimVarValue(simVarName, sdk.SimVarValueType.Feet)) {
                    SimVar.SetSimVarValue(simVarName, sdk.SimVarValueType.Feet, valueToSet);
                    if (this.transformSetToIncDec && this.lockDebounceTimer && typeof this.lockDebounceTimer.schedule === 'function') {
                        const selfMgr = this;
                        this.isLocked = true;
                        this.lockDebounceTimer.schedule(function () { selfMgr.isLocked = false; }, 250);
                    }
                }
            };
        } catch (e) {
            console.error('WTG1000NxiEnhancements: installAltOuterKnobApproachSnap error', e);
        }
    }

    // =========================================================================
    // 17. ILS / LOC Automatic GPS-to-LOC (Nav-to-Nav) Transition Fix
    //     Garmin G1000 NXi Pilot's Guide (190-02177-00 Rev. A, pp. 352, 360-363)
    // =========================================================================

    let lastManualCdiSwitchMs = 0;

    function hydrateNavDirectorConsumersFromSimVars(dir, index) {
        try {
            if (!dir || typeof SimVar === 'undefined' || typeof SimVar.GetSimVarValue !== 'function') {
                return;
            }
            const freq = Number(SimVar.GetSimVarValue('NAV ACTIVE FREQUENCY:' + index, sdk.SimVarValueType.MHz)) || 0;
            if (freq <= 0) {
                return;
            }
            if (dir.navFrequency && dir.navFrequency.get() === 0 && typeof dir.navFrequency.onEventConsumed === 'function') {
                dir.navFrequency.onEventConsumed(freq);
            }
            const sig = Number(SimVar.GetSimVarValue('NAV SIGNAL:' + index, sdk.SimVarValueType.Number)) || 0;
            if (dir.navSignal && dir.navSignal.get() === 0 && sig > 0 && typeof dir.navSignal.onEventConsumed === 'function') {
                dir.navSignal.onEventConsumed(sig);
            }
            const obs = Number(SimVar.GetSimVarValue('NAV OBS:' + index, sdk.SimVarValueType.Degree));
            if (dir.navObs && dir.navObs.get() === null && isFinite(obs) && typeof dir.navObs.onEventConsumed === 'function') {
                dir.navObs.onEventConsumed(obs);
            }
            const hasNav = !!SimVar.GetSimVarValue('NAV HAS NAV:' + index, sdk.SimVarValueType.Bool);
            if (dir.navHasNav && !dir.navHasNav.get() && hasNav && typeof dir.navHasNav.onEventConsumed === 'function') {
                dir.navHasNav.onEventConsumed(true);
            }
            const cdi = Number(SimVar.GetSimVarValue('NAV CDI:' + index, sdk.SimVarValueType.Number));
            if (dir.navCdi && dir.navCdi.get() === null && isFinite(cdi) && typeof dir.navCdi.onEventConsumed === 'function') {
                dir.navCdi.onEventConsumed(cdi);
            }
            const hasLoc = !!SimVar.GetSimVarValue('NAV HAS LOCALIZER:' + index, sdk.SimVarValueType.Bool);
            if (dir.navHasLoc && !dir.navHasLoc.get() && hasLoc && typeof dir.navHasLoc.onEventConsumed === 'function') {
                dir.navHasLoc.onEventConsumed(true);
            }
            const locDeg = Number(SimVar.GetSimVarValue('NAV LOCALIZER:' + index, sdk.SimVarValueType.Degree));
            if (dir.navLocCourse && dir.navLocCourse.get() === 0 && hasLoc && isFinite(locDeg) && typeof dir.navLocCourse.onEventConsumed === 'function') {
                dir.navLocCourse.onEventConsumed(locDeg * (Math.PI / 180));
            }
            const magVar = Number(SimVar.GetSimVarValue('NAV MAGVAR:' + index, sdk.SimVarValueType.Degree));
            if (dir.navMagVar && dir.navMagVar.get() === 0 && isFinite(magVar) && magVar !== 0 && typeof dir.navMagVar.onEventConsumed === 'function') {
                dir.navMagVar.onEventConsumed(magVar);
            }
        } catch (e) {}
    }

    function hydrateGsDirectorConsumersFromSimVars(dir, index) {
        try {
            if (!dir || typeof SimVar === 'undefined' || typeof SimVar.GetSimVarValue !== 'function') {
                return;
            }
            const freq = Number(SimVar.GetSimVarValue('NAV ACTIVE FREQUENCY:' + index, sdk.SimVarValueType.MHz)) || 0;
            if (freq <= 0) {
                return;
            }
            if (dir.navFrequency && dir.navFrequency.get() === 0 && typeof dir.navFrequency.onEventConsumed === 'function') {
                dir.navFrequency.onEventConsumed(freq);
            }
            const sig = Number(SimVar.GetSimVarValue('NAV SIGNAL:' + index, sdk.SimVarValueType.Number)) || 0;
            if (dir.navSignal && dir.navSignal.get() === 0 && sig > 0 && typeof dir.navSignal.onEventConsumed === 'function') {
                dir.navSignal.onEventConsumed(sig);
            }
            const hasGs = !!SimVar.GetSimVarValue('NAV HAS GLIDE SLOPE:' + index, sdk.SimVarValueType.Bool);
            if (dir.navHasGs && !dir.navHasGs.get() && hasGs && typeof dir.navHasGs.onEventConsumed === 'function') {
                dir.navHasGs.onEventConsumed(true);
            }
            const gsAngle = Number(SimVar.GetSimVarValue('NAV RAW GLIDE SLOPE:' + index, sdk.SimVarValueType.Degree));
            if (dir.navGsAngle && dir.navGsAngle.get() === 0 && hasGs && isFinite(gsAngle) && gsAngle > 0 && typeof dir.navGsAngle.onEventConsumed === 'function') {
                dir.navGsAngle.onEventConsumed(gsAngle);
            }
            const gsErr = Number(SimVar.GetSimVarValue('NAV GLIDE SLOPE ERROR:' + index, sdk.SimVarValueType.Degree));
            if (dir.navGsError && (dir.navGsError.get() === null || dir.navGsError.get() === 0) && hasGs && isFinite(gsErr) && typeof dir.navGsError.onEventConsumed === 'function') {
                dir.navGsError.onEventConsumed(gsErr);
            }
        } catch (e) {}
    }

    function wireAutopilotInstanceForNavToNav(ap) {
        try {
            if (!ap || ap.__wtg1000NavToNavWired) {
                return;
            }
            ap.__wtg1000NavToNavWired = true;

            const mgr = ap.navToNavManager;
            const mgr2 = ap.navToNavManagerToUse;
            if (!mgr || mgr.isNavToNavManager2 === true) {
                return;
            }
            mgr._wtAutopilot = ap;

            // Re-subscribe sourceChangeSub AFTER Autopilot.monitorEvents so apValues.cdiSource updates before transfer!
            if (mgr.sourceChangeSub && typeof mgr.sourceChangeSub.destroy === 'function') {
                mgr.sourceChangeSub.destroy();
            }
            const suffix = (sdk.CdiUtils && typeof sdk.CdiUtils.getEventBusTopicSuffix === 'function')
                ? sdk.CdiUtils.getEventBusTopicSuffix(ap.apValues.cdiId)
                : '';
            mgr.sourceChangeSub = ap.bus.getSubscriber().on('cdi_select' + suffix)
                .handle(function (e) {
                    mgr.handleNavToNavSourceChanged(e);
                }, !mgr.isSourceChanging);

            if (mgr2) {
                mgr2.getArmableNavRadioIndex = function () {
                    return mgr.canArmIndex > 0 ? mgr.canArmIndex : -1;
                };
                mgr2.getArmableVerticalMode = function () {
                    if (!mgr.canLocArm()) {
                        return sdk.APVerticalModes.NONE;
                    }
                    const apprType = mgr.approachDetails ? mgr.approachDetails.type : 0;
                    const AT = typeof ApproachType !== 'undefined' ? ApproachType : {};
                    const isIls = apprType === (AT.APPROACH_TYPE_ILS !== undefined ? AT.APPROACH_TYPE_ILS : 4);
                    const hasGs = mgr.canArmIndex >= 1
                        && typeof SimVar !== 'undefined'
                        && !!SimVar.GetSimVarValue('NAV HAS GLIDE SLOPE:' + mgr.canArmIndex, sdk.SimVarValueType.Bool);
                    return (isIls || hasGs) ? sdk.APVerticalModes.GS : sdk.APVerticalModes.NONE;
                };
                mgr2.isTransferInProgress = function () {
                    return !!(mgr.isSourceChanging || mgr._wtHoldGpssUntilLocCapture);
                };
                mgr2.onBeforeUpdate = function () {
                    if (typeof mgr._wtOnBeforeApUpdate === 'function') {
                        mgr._wtOnBeforeApUpdate();
                    }
                };
                mgr2.onAfterUpdate = function () {
                    if (typeof mgr._wtOnAfterApUpdate === 'function') {
                        mgr._wtOnAfterApUpdate();
                    }
                };
                if (ap.apValues) {
                    ap.apValues.navToNavArmableNavRadioIndex = mgr2.getArmableNavRadioIndex.bind(mgr2);
                    ap.apValues.navToNavArmableLateralMode = mgr2.getArmableLateralMode.bind(mgr2);
                    ap.apValues.navToNavArmableVerticalMode = mgr2.getArmableVerticalMode.bind(mgr2);
                    ap.apValues.navToNavTransferInProgress = mgr2.isTransferInProgress.bind(mgr2);
                }
            }

            if (typeof mgr.updateState === 'function') {
                mgr.updateState();
            }
        } catch (e) {}
    }

    function installIlsNavToNavFix(binder) {
        try {
            // 1. Track manual CDI switches (PFD CDI softkey / hardware GPS-NAV toggle) + FMA telemetry on MFD
            if (binder && binder.bus) {
                const sub = binder.bus.getSubscriber();
                const markManualCdi = function () {
                    lastManualCdiSwitchMs = Date.now();
                    try {
                        const mfdEl = (typeof document !== 'undefined' && document.querySelector) ? document.querySelector('wtg1000-mfd') : null;
                        const mgr = mfdEl && mfdEl.autopilot && mfdEl.autopilot.navToNavManager;
                        if (mgr) {
                            mgr._wtHoldGpssUntilLocCapture = false;
                        }
                    } catch (e) {}
                };
                sub.on('cdi_src_switch').handle(markManualCdi);
                sub.on('cdi_src_gps_toggle').handle(markManualCdi);

                if (isMfdContext) {
                    sub.on('fma_data').handle(function (fma) {
                        if (!fma) return;
                        safeSetSimVar('L:WTG1000_FMA_LAT', 'Number', Number(fma.lateralActive || 0));
                        safeSetSimVar('L:WTG1000_FMA_LAT_ARM', 'Number', Number(fma.lateralArmed || 0));
                        safeSetSimVar('L:WTG1000_FMA_VERT', 'Number', Number(fma.verticalActive || 0));
                        safeSetSimVar('L:WTG1000_FMA_VAPPR_ARM', 'Number', Number(fma.verticalApproachArmed || 0));
                        safeSetSimVar('L:WTG1000_FMA_LAT_FAIL', 'Number', fma.lateralModeFailed ? 1 : 0);
                    });
                    sub.on('cdi_select').handle(function (src) {
                        if (!src) return;
                        const code = src.type === sdk.NavSourceType.Gps ? 0 : Number(src.index || 1);
                        safeSetSimVar('L:WTG1000_CDI_SRC', 'Number', code);
                    });
                }
            }

            // 2. Patch APNavDirector & APGSDirector so ConsumerValue 1-frame 0 MHz handoff & subscription races never drop LOC/GS
            if (sdk.APNavDirector && sdk.APNavDirector.prototype && !sdk.APNavDirector.prototype.__wtg1000NavDirPatched) {
                const navProto = sdk.APNavDirector.prototype;
                navProto.__wtg1000NavDirPatched = true;
                const origNavOnCdi = navProto.onCdiSourceChanged;
                const origNavUpdateData = navProto.updateNavData;
                const origNavActivate = navProto.activate;
                const origNavUpdate = navProto.update;

                navProto.onCdiSourceChanged = function (source) {
                    origNavOnCdi.call(this, source);
                    if (source && source.type === sdk.NavSourceType.Nav && source.index >= 1 && source.index <= 4) {
                        hydrateNavDirectorConsumersFromSimVars(this, source.index);
                    }
                };
                navProto.updateNavData = function () {
                    if (this.navSource && this.navSource.type === sdk.NavSourceType.Nav && this.navSource.index >= 1 && this.navSource.index <= 4) {
                        if (this.navFrequency.get() === 0 || (!this.navHasLoc.get() && typeof SimVar !== 'undefined' && !!SimVar.GetSimVarValue('NAV HAS LOCALIZER:' + this.navSource.index, sdk.SimVarValueType.Bool))) {
                            hydrateNavDirectorConsumersFromSimVars(this, this.navSource.index);
                        }
                    }
                    return origNavUpdateData.call(this);
                };
                navProto.activate = function () {
                    if (this.forceNavSource === undefined && this.apValues && this.apValues.cdiSource) {
                        const curCdi = this.apValues.cdiSource.get();
                        if (curCdi && curCdi.type === sdk.NavSourceType.Nav
                            && (this.navSource.type !== curCdi.type || this.navSource.index !== curCdi.index)) {
                            this.onCdiSourceChanged(curCdi);
                        }
                    }
                    this.updateNavData();
                    origNavActivate.call(this);
                    if (this.activateNavData && this.navData && this.navData.frequency > 0 && this.activateNavData.frequency === 0) {
                        Object.assign(this.activateNavData.navSource, this.navData.navSource);
                        this.activateNavData.frequency = this.navData.frequency;
                    }
                };
                navProto.update = function () {
                    if (this.state === sdk.DirectorState.Active) {
                        this.updateNavData();
                        if (this.activateNavData && this.navData && this.navData.navSource.type === sdk.NavSourceType.Nav
                            && this.navData.navSource.index >= 1 && this.navData.frequency > 0) {
                            if (this.activateNavData.navSource.index === 0) {
                                Object.assign(this.activateNavData.navSource, this.navData.navSource);
                            }
                            if (this.activateNavData.navSource.index === this.navData.navSource.index
                                && (this.activateNavData.frequency === 0 || Math.abs(this.navData.frequency - this.activateNavData.frequency) < 0.005)) {
                                this.activateNavData.frequency = this.navData.frequency;
                            }
                        }
                    }
                    return origNavUpdate.call(this);
                };
            }

            if (sdk.APGSDirector && sdk.APGSDirector.prototype && !sdk.APGSDirector.prototype.__wtg1000GsDirPatched) {
                const gsProto = sdk.APGSDirector.prototype;
                gsProto.__wtg1000GsDirPatched = true;
                const origGsOnCdi = gsProto.onCdiSourceChanged;
                const origGsUpdateData = gsProto.updateNavData;
                const origGsActivate = gsProto.activate;
                const origGsUpdate = gsProto.update;

                gsProto.onCdiSourceChanged = function (source) {
                    origGsOnCdi.call(this, source);
                    if (source && source.type === sdk.NavSourceType.Nav && source.index >= 1 && source.index <= 4) {
                        hydrateGsDirectorConsumersFromSimVars(this, source.index);
                    }
                };
                gsProto.updateNavData = function () {
                    if (this.navSource && this.navSource.type === sdk.NavSourceType.Nav && this.navSource.index >= 1 && this.navSource.index <= 4) {
                        if (this.navFrequency.get() === 0 || (!this.navHasGs.get() && typeof SimVar !== 'undefined' && !!SimVar.GetSimVarValue('NAV HAS GLIDE SLOPE:' + this.navSource.index, sdk.SimVarValueType.Bool))) {
                            hydrateGsDirectorConsumersFromSimVars(this, this.navSource.index);
                        }
                    }
                    return origGsUpdateData.call(this);
                };
                gsProto.activate = function () {
                    if (this.forceNavSource === undefined && this.apValues && this.apValues.cdiSource) {
                        const curCdi = this.apValues.cdiSource.get();
                        if (curCdi && curCdi.type === sdk.NavSourceType.Nav
                            && (this.navSource.type !== curCdi.type || this.navSource.index !== curCdi.index)) {
                            this.onCdiSourceChanged(curCdi);
                        }
                    }
                    this.updateNavData();
                    origGsActivate.call(this);
                    if (this.activateNavData && this.navData && this.navData.frequency > 0 && this.activateNavData.frequency === 0) {
                        Object.assign(this.activateNavData.navSource, this.navData.navSource);
                        this.activateNavData.frequency = this.navData.frequency;
                    }
                };
                gsProto.update = function () {
                    if (this.state === sdk.DirectorState.Active) {
                        this.updateNavData();
                        if (this.activateNavData && this.navData && this.navData.navSource.type === sdk.NavSourceType.Nav
                            && this.navData.navSource.index >= 1 && this.navData.frequency > 0) {
                            if (this.activateNavData.navSource.index === 0) {
                                Object.assign(this.activateNavData.navSource, this.navData.navSource);
                            }
                            if (this.activateNavData.navSource.index === this.navData.navSource.index
                                && (this.activateNavData.frequency === 0 || Math.abs(this.navData.frequency - this.activateNavData.frequency) < 0.005)) {
                                this.activateNavData.frequency = this.navData.frequency;
                            }
                        }
                    }
                    return origGsUpdate.call(this);
                };
            }

            if (sdk.LNavDirector && sdk.LNavDirector.prototype && !sdk.LNavDirector.prototype.__wtg1000LnavDirPatched) {
                const lnavDirProto = sdk.LNavDirector.prototype;
                lnavDirProto.__wtg1000LnavDirPatched = true;
                const origLnavDirUpdate = lnavDirProto.update;
                lnavDirProto.update = function () {
                    origLnavDirUpdate.call(this);
                    if (this.state === sdk.DirectorState.Active && this.apValues && this.apValues.cdiSource) {
                        const cdi = this.apValues.cdiSource.get();
                        const inXfer = !!(this.apValues.navToNavTransferInProgress && this.apValues.navToNavTransferInProgress());
                        if (cdi && cdi.type !== sdk.NavSourceType.Gps && !inXfer) {
                            this.deactivate();
                        }
                    }
                };
            }

            // 3. Patch GarminNavToNavManager prototype for reliable arming, auto-switching, and seamless LOC + GS transfer
            const garmin = window.garminsdk;
            if (garmin && garmin.GarminNavToNavManager && garmin.GarminNavToNavManager.prototype
                && !garmin.GarminNavToNavManager.prototype.__wtg1000N2NPatched) {
                const n2nProto = garmin.GarminNavToNavManager.prototype;
                n2nProto.__wtg1000N2NPatched = true;
                const origCanLocActivate = n2nProto.canLocActivate;

                n2nProto._wtSyncLiveRadioData = function () {
                    try {
                        if (typeof SimVar === 'undefined' || typeof SimVar.GetSimVarValue !== 'function') {
                            return;
                        }
                        const f1 = Number(SimVar.GetSimVarValue('NAV ACTIVE FREQUENCY:1', sdk.SimVarValueType.MHz)) || 0;
                        const f2 = Number(SimVar.GetSimVarValue('NAV ACTIVE FREQUENCY:2', sdk.SimVarValueType.MHz)) || 0;
                        if (f1 > 0) {
                            this.nav1Frequency = Math.round(f1 * 100) / 100;
                            const hasLoc1 = !!SimVar.GetSimVarValue('NAV HAS LOCALIZER:1', sdk.SimVarValueType.Bool);
                            const crsDeg1 = hasLoc1 ? Number(SimVar.GetSimVarValue('NAV LOCALIZER:1', sdk.SimVarValueType.Degree)) : NaN;
                            this.nav1Localizer = (hasLoc1 && isFinite(crsDeg1))
                                ? { isValid: true, course: crsDeg1 * (Math.PI / 180) }
                                : { isValid: false, course: 0 };
                            const hasSig1 = (Number(SimVar.GetSimVarValue('NAV SIGNAL:1', sdk.SimVarValueType.Number)) || 0) > 0;
                            const cdi1 = hasSig1 ? Number(SimVar.GetSimVarValue('NAV CDI:1', sdk.SimVarValueType.Number)) : NaN;
                            this.nav1Cdi = (hasSig1 && isFinite(cdi1)) ? { deviation: cdi1 } : { deviation: null };
                        }
                        if (f2 > 0) {
                            this.nav2Frequency = Math.round(f2 * 100) / 100;
                            const hasLoc2 = !!SimVar.GetSimVarValue('NAV HAS LOCALIZER:2', sdk.SimVarValueType.Bool);
                            const crsDeg2 = hasLoc2 ? Number(SimVar.GetSimVarValue('NAV LOCALIZER:2', sdk.SimVarValueType.Degree)) : NaN;
                            this.nav2Localizer = (hasLoc2 && isFinite(crsDeg2))
                                ? { isValid: true, course: crsDeg2 * (Math.PI / 180) }
                                : { isValid: false, course: 0 };
                            const hasSig2 = (Number(SimVar.GetSimVarValue('NAV SIGNAL:2', sdk.SimVarValueType.Number)) || 0) > 0;
                            const cdi2 = hasSig2 ? Number(SimVar.GetSimVarValue('NAV CDI:2', sdk.SimVarValueType.Number)) : NaN;
                            this.nav2Cdi = (hasSig2 && isFinite(cdi2)) ? { deviation: cdi2 } : { deviation: null };
                        }
                        const hdg = Number(SimVar.GetSimVarValue('PLANE HEADING DEGREES MAGNETIC', sdk.SimVarValueType.Degree));
                        if (isFinite(hdg)) {
                            this.currentHeading = hdg;
                        }
                        const pLat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees')) || 0;
                        const pLon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees')) || 0;
                        if ((pLat !== 0 || pLon !== 0) && this.planePos && typeof this.planePos.set === 'function') {
                            this.planePos.set(pLat, pLon);
                        }
                        if (this.apValues && this.apValues.cdiSource) {
                            this.activeSource = this.apValues.cdiSource.get();
                        }
                    } catch (e) {}
                };

                n2nProto.updateState = function () {
                    this._wtSyncLiveRadioData();
                    const AT = typeof ApproachType !== 'undefined' ? ApproachType : {};
                    const tILS = AT.APPROACH_TYPE_ILS !== undefined ? AT.APPROACH_TYPE_ILS : 4;
                    const tLOC = AT.APPROACH_TYPE_LOCALIZER !== undefined ? AT.APPROACH_TYPE_LOCALIZER : 5;
                    const tSDF = AT.APPROACH_TYPE_SDF !== undefined ? AT.APPROACH_TYPE_SDF : 6;
                    const tLDA = AT.APPROACH_TYPE_LDA !== undefined ? AT.APPROACH_TYPE_LDA : 7;

                    const details = this.approachDetails;
                    const apprReady = !!(this.apValues.approachIsActive.get() || (details && details.isLoaded));
                    if (details && details.referenceFacility
                        && (details.type === tILS || details.type === tLOC || details.type === tLDA || details.type === tSDF)
                        && apprReady) {
                        const apprFreq = Math.round(details.referenceFacility.freqMHz * 100) / 100;
                        if (apprFreq > 107) {
                            if (Math.abs(apprFreq - this.nav1Frequency) < 0.005 && this.nav1Localizer && this.nav1Localizer.isValid) {
                                this.canArmIndex = 1;
                            } else if (Math.abs(apprFreq - this.nav2Frequency) < 0.005 && this.nav2Localizer && this.nav2Localizer.isValid) {
                                this.canArmIndex = 2;
                            } else {
                                this.canArmIndex = 0;
                            }
                        } else {
                            this.canArmIndex = 0;
                        }
                    } else {
                        this.canArmIndex = 0;
                    }
                };

                n2nProto.canLocActivate = function () {
                    this._wtSyncLiveRadioData();
                    if (origCanLocActivate.call(this)) {
                        return true;
                    }
                    if (this.canArmIndex < 1) {
                        return false;
                    }
                    const cdi = this.canArmIndex === 1 ? this.nav1Cdi : this.nav2Cdi;
                    const loc = this.canArmIndex === 1 ? this.nav1Localizer : this.nav2Localizer;
                    if (cdi && cdi.deviation !== null && cdi.deviation !== undefined && Math.abs(cdi.deviation) < 120
                        && loc && loc.isValid && loc.course) {
                        const dtk = loc.course * (180 / Math.PI);
                        const headingDiff = sdk.NavMath.diffAngle(this.currentHeading, dtk);
                        // Also capture when already established near centerline (e.g. crabbing into crosswind on GPSS)
                        if (Math.abs(cdi.deviation) < 65 && Math.abs(headingDiff) < 35) {
                            return true;
                        }
                    }
                    return false;
                };

                n2nProto.tryAutoSwitchSource = function () {
                    if (this.navToNavCompleted || this.isSourceChanging) {
                        return;
                    }
                    this.updateState();
                    if (this.canArmIndex <= 0) {
                        return;
                    }
                    const curSrc = (this.apValues && this.apValues.cdiSource) ? this.apValues.cdiSource.get() : this.activeSource;
                    if (!curSrc || curSrc.type !== sdk.NavSourceType.Gps) {
                        return;
                    }
                    const flightPlanner = (this.fms && typeof this.fms.get === 'function' && this.fms.get())
                        ? this.fms.get().flightPlanner
                        : this.flightPlanner;
                    if (!flightPlanner || !flightPlanner.hasActiveFlightPlan()) {
                        return;
                    }
                    const plan = flightPlanner.getActiveFlightPlan();
                    if (!plan || plan.length < 1) {
                        return;
                    }
                    const legIdx = (this.lnavTrackedLegIndex >= 0 && this.lnavTrackedLegIndex < plan.length)
                        ? this.lnavTrackedLegIndex
                        : plan.activeLateralLeg;
                    if (typeof legIdx !== 'number' || legIdx < 0 || legIdx >= plan.length) {
                        return;
                    }
                    const segIdx = plan.getSegmentIndex(legIdx);
                    const seg = segIdx >= 0 ? plan.getSegment(segIdx) : null;
                    if (!seg || seg.segmentType !== sdk.FlightPlanSegmentType.Approach) {
                        return;
                    }
                    const segLegIdx = legIdx - seg.offset;
                    const currentLeg = seg.legs[segLegIdx];
                    if (!currentLeg || !currentLeg.leg) {
                        return;
                    }
                    const missedFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.MissedApproach) ? sdk.LegDefinitionFlags.MissedApproach : 2;
                    if ((currentLeg.flags & missedFlag) !== 0) {
                        return;
                    }
                    const Lt = sdk.LegType || {};
                    if (isHoldLegType(currentLeg.leg.type) || currentLeg.leg.type === Lt.PI) {
                        return;
                    }
                    // Find FAF leg in Approach segment; ensure no hold or procedure turn remains ahead of currentLeg before FAF
                    const fafFlag = (sdk.FixTypeFlags && sdk.FixTypeFlags.FAF) ? sdk.FixTypeFlags.FAF : 8;
                    let fafLeg = null;
                    for (let i = segLegIdx; i < seg.legs.length; i++) {
                        const ld = seg.legs[i];
                        if (!ld || !ld.leg) continue;
                        if ((ld.flags & missedFlag) !== 0) break;
                        if (i > segLegIdx && (isHoldLegType(ld.leg.type) || ld.leg.type === Lt.PI)) {
                            return;
                        }
                        if ((ld.leg.fixTypeFlags & fafFlag) !== 0) {
                            fafLeg = ld;
                            break;
                        }
                    }
                    const refLeg = fafLeg || currentLeg;
                    let distToFafNm = 5;
                    if (refLeg.calculated && typeof refLeg.calculated.endLat === 'number' && typeof refLeg.calculated.endLon === 'number') {
                        if (this.planePos.lat === 0 && this.planePos.lon === 0 && typeof SimVar !== 'undefined') {
                            const pLat = Number(SimVar.GetSimVarValue('PLANE LATITUDE', 'degrees')) || 0;
                            const pLon = Number(SimVar.GetSimVarValue('PLANE LONGITUDE', 'degrees')) || 0;
                            if (pLat !== 0 || pLon !== 0) {
                                this.planePos.set(pLat, pLon);
                            }
                        }
                        if (this.planePos.lat !== 0 || this.planePos.lon !== 0) {
                            distToFafNm = sdk.UnitType.GA_RADIAN.convertTo(
                                this.planePos.distance(refLeg.calculated.endLat, refLeg.calculated.endLon),
                                sdk.UnitType.NMILE
                            );
                        }
                    }

                    if (distToFafNm < 15 && this.canLocActivate()) {
                        const ap = this._wtAutopilot;
                        this._wtPreSwitch = {
                            wasLocArmed: this.apValues.lateralArmed.get() === sdk.APLateralModes.LOC,
                            wasGpssActive: this.apValues.lateralActive.get() === sdk.APLateralModes.GPSS,
                            wasGsArmed: ap ? (ap.verticalApproachArmed === sdk.APVerticalModes.GS) : false,
                            targetIndex: this.canArmIndex,
                            timeMs: Date.now()
                        };
                        if (this.sourceChangeSub && typeof this.sourceChangeSub.resume === 'function') {
                            this.sourceChangeSub.resume();
                        }
                        this.changeSource();
                    }
                };

                n2nProto.handleNavToNavSourceChanged = function (e) {
                    if (!e || e.type !== sdk.NavSourceType.Nav || e.index !== this.canArmIndex) {
                        return;
                    }
                    if (!this.isSourceChanging && this.navToNavCompleted) {
                        return;
                    }
                    // Ensure apValues.cdiSource and AP directors are synced BEFORE activating LOC!
                    if (this._wtAutopilot) {
                        this._wtAutopilot.cdiSource = e;
                    }
                    if (this.apValues && this.apValues.cdiSource) {
                        const cur = this.apValues.cdiSource.get();
                        if (!cur || cur.type !== e.type || cur.index !== e.index) {
                            this.apValues.cdiSource.set(e);
                        }
                    }
                    this.activeSource = e;

                    const ap = this._wtAutopilot;
                    const locDir = ap && ap.lateralModes ? ap.lateralModes.get(sdk.APLateralModes.LOC) : null;
                    const gsDir = ap && ap.verticalModes ? ap.verticalModes.get(sdk.APVerticalModes.GS) : null;
                    if (locDir && typeof locDir.updateNavData === 'function') {
                        locDir.updateNavData();
                    }
                    if (gsDir && typeof gsDir.updateNavData === 'function') {
                        gsDir.updateNavData();
                    }

                    const pre = this._wtPreSwitch || {
                        wasLocArmed: this.apValues.lateralArmed.get() === sdk.APLateralModes.LOC,
                        wasGpssActive: this.apValues.lateralActive.get() === sdk.APLateralModes.GPSS,
                        wasGsArmed: ap ? (ap.verticalApproachArmed === sdk.APVerticalModes.GS) : false
                    };

                    this.navToNavCompleted = true;
                    this.isSourceChanging = false;
                    if (this.sourceChangeSub && typeof this.sourceChangeSub.pause === 'function') {
                        this.sourceChangeSub.pause();
                    }

                    if (pre.wasLocArmed) {
                        this._wtHoldGpssUntilLocCapture = false;
                        this.onTransferred();
                        // Keep GS armed if APR had armed GS prior to the GPS->LOC switch
                        if (pre.wasGsArmed && gsDir && gsDir.state === sdk.DirectorState.Inactive && typeof gsDir.arm === 'function') {
                            gsDir.arm();
                        }
                    } else if (pre.wasGpssActive && Date.now() - lastManualCdiSwitchMs > 1500) {
                        // Garmin Pilot's Guide p. 352: When auto-switching to LOC while GPS NAV mode is active (without APR),
                        // LOC arms automatically and GPS remains active until LOC captures (reverting to ROL if FAF is passed uncaptured).
                        const canCaptureNow = locDir && typeof locDir.canActivate === 'function'
                            ? locDir.canActivate(sdk.APLateralModes.LOC, this.apValues, locDir.navData)
                            : true;
                        if (canCaptureNow) {
                            this._wtHoldGpssUntilLocCapture = false;
                            this.onTransferred();
                        } else if (locDir && typeof locDir.arm === 'function') {
                            this._wtHoldGpssUntilLocCapture = true;
                            locDir.arm();
                        }
                    }
                    safeSetSimVar('L:WTG1000_LAST_N2N_RESULT', 'Number', Number(this.apValues.lateralActive.get() || 0));
                };

                n2nProto._wtOnBeforeApUpdate = function () {
                    // If the pilot switched CDI back to GPS and LOC is actively armed on the scoreboard,
                    // clear any stale navToNavCompleted flag so re-intercepting the localizer always captures LOC!
                    if (this.navToNavCompleted && !this.isSourceChanging && this.apValues) {
                        const curCdi = this.apValues.cdiSource ? this.apValues.cdiSource.get() : this.activeSource;
                        if (curCdi && curCdi.type === sdk.NavSourceType.Gps
                            && this.apValues.lateralArmed && this.apValues.lateralArmed.get() === sdk.APLateralModes.LOC) {
                            this.navToNavCompleted = false;
                        }
                    }
                    const now = Date.now();
                    if (!this.navToNavCompleted && !this.isSourceChanging && (!this._wtLastPollMs || now - this._wtLastPollMs >= 250)) {
                        this._wtLastPollMs = now;
                        this.tryAutoSwitchSource();
                    }
                };

                n2nProto._wtOnAfterApUpdate = function () {
                    if (this.isSourceChanging && this.apValues && this.apValues.cdiSource) {
                        const cur = this.apValues.cdiSource.get();
                        if (cur && cur.type === sdk.NavSourceType.Nav && cur.index === this.canArmIndex) {
                            this.handleNavToNavSourceChanged(cur);
                        }
                    }
                    if (this._wtHoldGpssUntilLocCapture) {
                        const latAct = this.apValues.lateralActive.get();
                        const latArm = this.apValues.lateralArmed.get();
                        if (latAct === sdk.APLateralModes.LOC || latArm !== sdk.APLateralModes.LOC || (Date.now() - lastManualCdiSwitchMs < 1500)) {
                            this._wtHoldGpssUntilLocCapture = false;
                            return;
                        }
                        // Check if aircraft sequenced past the FAF without capturing LOC -> release hold so GPSS reverts to ROL
                        try {
                            const fp = (this.fms && typeof this.fms.get === 'function' && this.fms.get())
                                ? this.fms.get().flightPlanner
                                : this.flightPlanner;
                            const plan = fp && fp.hasActiveFlightPlan() ? fp.getActiveFlightPlan() : null;
                            if (plan && plan.activeLateralLeg >= 0 && plan.activeLateralLeg < plan.length) {
                                const curLeg = plan.getLeg(plan.activeLateralLeg);
                                const missedFlag = (sdk.LegDefinitionFlags && sdk.LegDefinitionFlags.MissedApproach) ? sdk.LegDefinitionFlags.MissedApproach : 2;
                                const fixIcao = (curLeg && curLeg.leg && curLeg.leg.fixIcao) ? String(curLeg.leg.fixIcao) : '';
                                const isRwy = (sdk.ICAO && typeof sdk.ICAO.getFacilityType === 'function' && sdk.FacilityType)
                                    ? (sdk.ICAO.getFacilityType(fixIcao) === sdk.FacilityType.RWY)
                                    : (fixIcao.charAt(0) === 'R');
                                if ((curLeg.flags & missedFlag) !== 0 || isRwy) {
                                    this._wtHoldGpssUntilLocCapture = false;
                                }
                            }
                        } catch (e) {}
                    }
                };
            }

            // 4. Hook Autopilot prototype + live MFD Autopilot instance so pre-constructed & newly-constructed instances are wired
            if (sdk.Autopilot && sdk.Autopilot.prototype && !sdk.Autopilot.prototype.__wtg1000ApHooked) {
                const apProto = sdk.Autopilot.prototype;
                apProto.__wtg1000ApHooked = true;
                const origApUpdate = apProto.update;
                const origApApproachPressed = apProto.approachPressed;
                apProto.update = function () {
                    if (!this.__wtg1000NavToNavWired) {
                        wireAutopilotInstanceForNavToNav(this);
                    }
                    return origApUpdate.call(this);
                };
                if (typeof origApApproachPressed === 'function') {
                    apProto.approachPressed = function (set) {
                        if (!this.__wtg1000NavToNavWired) {
                            wireAutopilotInstanceForNavToNav(this);
                        }
                        return origApApproachPressed.call(this, set);
                    };
                }
            }
            if (garmin && garmin.GarminAutopilot && garmin.GarminAutopilot.prototype && !garmin.GarminAutopilot.prototype.__wtg1000GarminApHooked) {
                const gApProto = garmin.GarminAutopilot.prototype;
                gApProto.__wtg1000GarminApHooked = true;
                const origGarminApprPressed = gApProto.approachPressed;
                if (typeof origGarminApprPressed === 'function') {
                    gApProto.approachPressed = function (set) {
                        if (!this.__wtg1000NavToNavWired) {
                            wireAutopilotInstanceForNavToNav(this);
                        }
                        if (this.navToNavManager && typeof this.navToNavManager.updateState === 'function') {
                            const curCdi = this.apValues && this.apValues.cdiSource ? this.apValues.cdiSource.get() : null;
                            if (curCdi && curCdi.type === sdk.NavSourceType.Gps && !this.navToNavManager.isSourceChanging) {
                                this.navToNavManager.navToNavCompleted = false;
                            }
                            this.navToNavManager.updateState();
                        }
                        return origGarminApprPressed.call(this, set);
                    };
                }
            }

            try {
                if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
                    const mfdEl = document.querySelector('wtg1000-mfd');
                    if (mfdEl && mfdEl.autopilot) {
                        wireAutopilotInstanceForNavToNav(mfdEl.autopilot);
                    }
                }
            } catch (e) {}
        } catch (e) {
            console.error('WTG1000NxiEnhancements: installIlsNavToNavFix error', e);
        }
    }

    // =========================================================================
    // 9. Garmin G1000 NXi Avionics Failure & Annunciation Engine (190-02177-00 Rev. A)
    // =========================================================================

    const FAIL_LRU_BIT = {
        COM1:      1 << 0,   // 1
        COM2:      1 << 1,   // 2
        GDC1:      1 << 2,   // 4       Air Data Computer (IAS, ALT, VSI, TAS, OAT)
        GDL69:     1 << 3,   // 8       SiriusXM Datalink
        GDU1:      1 << 4,   // 16      PFD1 Display Unit (blanks PFD1, COM1/NAV1 invalid; operator activates DISPLAY BACKUP for Reversionary)
        GDU2:      1 << 5,   // 32      MFD1 Display Unit (blanks MFD1, COM2/NAV2 invalid; operator activates DISPLAY BACKUP for Reversionary)
        GEA1:      1 << 6,   // 64      Engine/Airframe Unit (EIS Red Xs)
        GIA1:      1 << 7,   // 128     Integrated Avionics #1 (cascades to COM1, NAV1, GS1, GPS1, AFCS)
        GIA2:      1 << 8,   // 256     Integrated Avionics #2 (cascades to COM2, NAV2, GS2, GPS2, AFCS)
        GMA1:      1 << 9,   // 512     Audio Panel (Fail-Safe to COM1 only)
        GMU1:      1 << 10,  // 1024    Magnetometer (Heading Red X ONLY; Attitude stays valid!)
        GPS1:      1 << 11,  // 2048    GPS/WAAS Receiver #1
        GPS2:      1 << 12,  // 4096    GPS/WAAS Receiver #2
        GRS1:      1 << 13,  // 8192    AHRS Attitude & Heading Reference System
        GS1:       1 << 14,  // 16384   Glideslope Receiver #1
        GS2:       1 << 15,  // 32768   Glideslope Receiver #2
        GSA_PTCH:  1 << 16,  // 65536   GFC 700 Pitch Servo
        GSA_ROLL:  1 << 17,  // 131072  GFC 700 Roll Servo
        GSA_PTRIM: 1 << 18,  // 262144  GFC 700 Pitch Trim Servo
        GTS800:    1 << 19,  // 524288  TAS Traffic System
        GTX1:      1 << 20   // 1048576 Transponder (XPDR FAIL Red X)
    };

    const FAIL_EXTRA_BIT = {
        WAAS:           1 << 0,   // 1     SBAS/WAAS Lost (3D NAV; APR DWNGRADE on LPV/LP+V/LNAV+V)
        RAIM:           1 << 1,   // 2     RAIM / GPS Loss of Integrity (GPS LOI)
        NAV1:           1 << 2,   // 4     VHF NAV1/LOC1 Receiver Failed (Red X on NAV1 only)
        NAV2:           1 << 3,   // 8     VHF NAV2/LOC2 Receiver Failed (Red X on NAV2 only)
        OAT:            1 << 4,   // 16    OAT Probe Failed (Red X on OAT & TAS only)
        ADC_IAS:        1 << 5,   // 32    ADC Airspeed Channel Failed (Red X on IAS & TAS)
        ADC_ALT:        1 << 6,   // 64    ADC Altitude/VS Channel Failed (Red X on ALT & VSI)
        AHRS_ALIGN:     1 << 7,   // 128   AHRS Aligning ('AHRS ALIGN: Keep Wings Level' + HDG Red X)
        DISPLAY_BACKUP: 1 << 8,   // 256   Manual Red DISPLAY BACKUP Button Active (Reversionary Mode)
        COM1_PTT:       1 << 9,   // 512   COM1 Stuck Mic (30s PTT timeout / COM1 PTT alert)
        COM2_PTT:       1 << 10,  // 1024  COM2 Stuck Mic
        AFCS_PFT:       1 << 11,  // 2048  GFC 700 Pre-Flight Test Fail (Red 'PFT')
        TAWS_FAIL:      1 << 12,  // 4096  TAWS/Terrain System Fault ('TAWS FAIL')
        PITOT_BLOCKED:  1 << 13,  // 8192  Insidious Pitot Ram+Drain Blockage (No Red X; IAS acts like altimeter)
        STATIC_BLOCKED: 1 << 14   // 16384 Insidious Static Port Blockage (No Red X; ALT frozen, VSI=0, IAS error)
    };

    const failureRuntime = {
        installed: false,
        isPfd: false,
        isMfd: false,
        bus: null,
        fms: null,
        cdiIsGps: true,
        cdiNavIndex: 1,
        cdiScaleLabel: 'ENR',
        brg1SourceType: -1, // 0=NAV, 1=GPS, -1=OFF
        brg1SourceIndex: 1,
        brg2SourceType: -1,
        brg2SourceIndex: 1,
        rawIasKts: 0,
        rawIndAltFt: 0,
        rawPressAltFt: 0,
        pitotLocked: false,
        pitotLockIasKts: 0,
        pitotLockPressAltFt: 0,
        staticLocked: false,
        staticLockIndAltFt: 0,
        staticLockPressAltFt: 0,
        dataIntegrityModules: [],
        lastBusStates: {
            adc: 'On',
            adc1: 'On',
            ahrs: 'On',
            mag: 'On',
            gia1: 'On',
            gia2: 'On',
            gea1: 'On',
            xpdr: 'On'
        },
        wasGpsLoi: false,
        gpsIntegOkUntilMs: 0,
        activeAlertKeys: {},
        lastStateSig: '',
        applyingBusGuard: false,
        binder: null,
        pfdReversionaryActive: false,
        mfdReversionaryActive: false,
        mfdRevLoading: false,
        mfdRevMounted: false,
        mfdRevCallbacks: [],
        mfdRevPfdMod: null,
        mfdRevViewService: null,
        mfdRevMapInsetRef: null,
        mfdRevHsiRef: null,
        mfdRevBipRef: null,
        mfdRevRootMenu: null,
        mfdSavedPageKey: 'NavMapPage',
        mfdFirstRevEntryDone: false
    };

    function computeStandardPressureRatio(pressAltFt) {
        const h = Math.max(-2000, Math.min(60000, Number(pressAltFt) || 0));
        return Math.pow(Math.max(0.05, 1.0 - 6.8755856e-6 * h), 5.2558797);
    }

    function computeImpactPressureRatioFromIas(iasKts) {
        const v = Math.max(0, Number(iasKts) || 0);
        const a0 = 661.4786; // Sea-level speed of sound in knots
        return Math.pow(1.0 + 0.2 * Math.pow(v / a0, 2), 3.5) - 1.0;
    }

    function computeIasFromImpactPressureRatio(qcRatio) {
        if (!(qcRatio > 0)) return 0;
        const a0 = 661.4786;
        const term = Math.pow(qcRatio + 1.0, 1.0 / 3.5) - 1.0;
        if (!(term > 0)) return 0;
        return a0 * Math.sqrt(5.0 * term);
    }

    function computePitotStaticIas(trueIasKts, pressAltFt, pitotBlocked, pitotLockIasKts, pitotLockPressAltFt, staticBlocked, staticLockPressAltFt) {
        if (!pitotBlocked && !staticBlocked) {
            return Math.max(0, Number(trueIasKts) || 0);
        }
        if (pitotBlocked && staticBlocked) {
            return Math.max(0, Number(pitotLockIasKts) || 0);
        }
        const psAmbient = computeStandardPressureRatio(pressAltFt);
        const ptActual = psAmbient + computeImpactPressureRatioFromIas(trueIasKts);
        const ptSensed = pitotBlocked
            ? (computeStandardPressureRatio(pitotLockPressAltFt) + computeImpactPressureRatioFromIas(pitotLockIasKts))
            : ptActual;
        const psSensed = staticBlocked
            ? computeStandardPressureRatio(staticLockPressAltFt)
            : psAmbient;
        return Math.max(0, Math.min(450, computeIasFromImpactPressureRatio(ptSensed - psSensed)));
    }

    function detectApproachContext(fms, cdiScaleLabel) {
        let isApproachActive = false;
        let isVertGuidedApr = false;
        let isTermOrAprOrDprt = false;
        const lbl = String(cdiScaleLabel || '').toUpperCase();
        if (lbl && lbl !== 'ENR' && lbl !== 'OCN') {
            isTermOrAprOrDprt = true;
        }
        if (/LPV|LP\+V|LNAV\+V|V-APR/.test(lbl)) {
            isApproachActive = true;
            isVertGuidedApr = true;
        } else if (/LNAV|LP|MAPR|APR|VISUAL/.test(lbl)) {
            isApproachActive = true;
        }
        try {
            if (fms && typeof fms.hasPrimaryFlightPlan === 'function' && fms.hasPrimaryFlightPlan()) {
                const plan = fms.getPrimaryFlightPlan();
                if (plan && plan.activeLateralLeg >= 0 && plan.activeLateralLeg < plan.length) {
                    const seg = plan.getSegment(plan.getSegmentIndex(plan.activeLateralLeg));
                    if (seg && sdk && sdk.FlightPlanSegmentType) {
                        if (seg.segmentType === sdk.FlightPlanSegmentType.Approach) {
                            isApproachActive = true;
                            isTermOrAprOrDprt = true;
                        } else if (seg.segmentType === sdk.FlightPlanSegmentType.Departure) {
                            isTermOrAprOrDprt = true;
                        }
                    }
                }
                const ud = plan && plan.getUserData ? plan.getUserData('approach_details') : null;
                if (ud && isApproachActive) {
                    const rt = Number(ud.referenceType || ud.type || 0);
                    const garmin = window.garminsdk || {};
                    const aat = garmin.AdditionalApproachType || {};
                    const ext = sdk.ExtendedApproachType || sdk.ApproachType || {};
                    if (rt === ext.APPROACH_TYPE_RNAV || rt === aat.APPROACH_TYPE_RNAV_LPV || rt === aat.APPROACH_TYPE_RNAV_LP_V || rt === aat.APPROACH_TYPE_RNAV_LNAV_V) {
                        if (!lbl || /LPV|LP\+V|LNAV\+V|^$/.test(lbl)) {
                            isVertGuidedApr = true;
                        }
                    }
                }
            }
        } catch (e) {}
        return {
            isApproachActive: isApproachActive,
            isVertGuidedApr: isVertGuidedApr,
            isTermOrAprOrDprt: isTermOrAprOrDprt
        };
    }

    function computeEffectiveAvionicsFailureState(overrides) {
        let rawLruMask = 0;
        let rawExtraMask = 0;
        let legGps1 = 0;
        let legGps2 = 0;
        let legWaas = 0;
        let legRaim = 0;
        let hwBackup = 0;

        if (overrides && typeof overrides === 'object') {
            rawLruMask = Math.max(0, Math.floor(Number(overrides.lruMask) || 0));
            rawExtraMask = Math.max(0, Math.floor(Number(overrides.extraMask) || 0));
            if (overrides.hwDisplayBackup !== undefined) {
                hwBackup = Number(overrides.hwDisplayBackup) || 0;
            }
        } else {
            try {
                if (typeof SimVar !== 'undefined') {
                    rawLruMask = Math.max(0, Math.floor(Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_LRU_MASK', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_LRU_MASK', 'Number') || 0)));
                    rawExtraMask = Math.max(0, Math.floor(Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_EXTRA_MASK', 'Number') || 0)));
                    legGps1 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS1', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS1', 'Number') || 0);
                    legGps2 = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_GPS2', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_GPS2', 'Number') || 0);
                    legWaas = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_WAAS', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_WAAS', 'Number') || 0);
                    legRaim = Number(SimVar.GetSimVarValue('L:WTG1000_FAIL_RAIM', 'Number') || SimVar.GetSimVarValue('L:CT182T_FAIL_RAIM', 'Number') || 0);
                    hwBackup = Number(SimVar.GetSimVarValue('L:AS1000_MID_Display_Backup_Active', 'Number') || SimVar.GetSimVarValue('L:AS1000_MIDCom_Display_Backup_Active', 'Number') || 0);
                }
            } catch (e) {}
        }

        const hasLru = function (bit) { return (rawLruMask & bit) !== 0; };
        const hasExtra = function (bit) { return (rawExtraMask & bit) !== 0; };

        const gia1Fail = hasLru(FAIL_LRU_BIT.GIA1);
        const gia2Fail = hasLru(FAIL_LRU_BIT.GIA2);
        const gdu1Fail = hasLru(FAIL_LRU_BIT.GDU1);
        const gdu2Fail = hasLru(FAIL_LRU_BIT.GDU2);
        const displayBackup = hasExtra(FAIL_EXTRA_BIT.DISPLAY_BACKUP) || hwBackup > 0;

        // Cascading dependencies per Garmin G1000 NXi Pilot's Guide (190-02177-00 Rev. A) Fig. 1-1 & Fig. 1-5:
        // - GIA1 hosts COM1, NAV1, GS1, GPS1; GIA2 hosts COM2, NAV2, GS2, GPS2.
        // - GDU1 (PFD) failure invalidates COM1 & NAV1 HSDB tuning path (Fig. 1-5, p. 23);
        //   GDU2 (MFD) failure invalidates COM2 & NAV2 HSDB tuning path.
        const com1Fail = hasLru(FAIL_LRU_BIT.COM1) || gia1Fail || gdu1Fail;
        const com2Fail = hasLru(FAIL_LRU_BIT.COM2) || gia2Fail || gdu2Fail;
        const nav1Fail = hasExtra(FAIL_EXTRA_BIT.NAV1) || gia1Fail || gdu1Fail;
        const nav2Fail = hasExtra(FAIL_EXTRA_BIT.NAV2) || gia2Fail || gdu2Fail;
        const gs1Fail  = hasLru(FAIL_LRU_BIT.GS1) || gia1Fail || nav1Fail;
        const gs2Fail  = hasLru(FAIL_LRU_BIT.GS2) || gia2Fail || nav2Fail;
        const gps1Fail = hasLru(FAIL_LRU_BIT.GPS1) || gia1Fail || legGps1 > 0;
        const gps2Fail = hasLru(FAIL_LRU_BIT.GPS2) || gia2Fail || legGps2 > 0;
        const gpsBothFail = gps1Fail && gps2Fail;
        const activeGps = !gps1Fail ? 1 : (!gps2Fail ? 2 : 0);

        const gdc1Fail = hasLru(FAIL_LRU_BIT.GDC1);
        const gdl69Fail = hasLru(FAIL_LRU_BIT.GDL69);
        const gea1Fail = hasLru(FAIL_LRU_BIT.GEA1);
        const gma1Fail = hasLru(FAIL_LRU_BIT.GMA1);
        const gmu1Fail = hasLru(FAIL_LRU_BIT.GMU1);
        const grs1Fail = hasLru(FAIL_LRU_BIT.GRS1);
        const gsaPtchFail = hasLru(FAIL_LRU_BIT.GSA_PTCH);
        const gsaRollFail = hasLru(FAIL_LRU_BIT.GSA_ROLL);
        const gsaPtrimFail = hasLru(FAIL_LRU_BIT.GSA_PTRIM);
        const gts800Fail = hasLru(FAIL_LRU_BIT.GTS800);
        const gtx1Fail = hasLru(FAIL_LRU_BIT.GTX1);

        const waasFail = hasExtra(FAIL_EXTRA_BIT.WAAS) || legWaas > 0;
        const raimFail = hasExtra(FAIL_EXTRA_BIT.RAIM) || legRaim > 0;
        const oatFail = hasExtra(FAIL_EXTRA_BIT.OAT);
        const adcIasFail = hasExtra(FAIL_EXTRA_BIT.ADC_IAS);
        const adcAltFail = hasExtra(FAIL_EXTRA_BIT.ADC_ALT);
        const ahrsAlign = hasExtra(FAIL_EXTRA_BIT.AHRS_ALIGN);
        const com1Ptt = hasExtra(FAIL_EXTRA_BIT.COM1_PTT) && !com1Fail;
        const com2Ptt = hasExtra(FAIL_EXTRA_BIT.COM2_PTT) && !com2Fail;
        const afcsPftFail = hasExtra(FAIL_EXTRA_BIT.AFCS_PFT);
        const tawsFail = hasExtra(FAIL_EXTRA_BIT.TAWS_FAIL);
        const pitotBlocked = hasExtra(FAIL_EXTRA_BIT.PITOT_BLOCKED);
        const staticBlocked = hasExtra(FAIL_EXTRA_BIT.STATIC_BLOCKED);

        // Air Data channels
        const iasInvalid = gdc1Fail || adcIasFail;
        const altInvalid = gdc1Fail || adcAltFail;
        const oatInvalid = gdc1Fail || oatFail;
        const tasInvalid = iasInvalid || oatInvalid;

        // ADAHRS Sensor Matrix (Table 1-2 & Fig. 1-7, pp. 14-15):
        // - GMU1 (Magnetometer) failure invalidates HEADING ONLY while keeping Pitch & Roll Attitude VALID
        //   ('AHRS no-Mag Mode'), as long as GRS1 has either GPS or Airspeed aiding!
        // - If GRS1 loses BOTH GPS1+GPS2 AND Airspeed (GDC1/IAS), AHRS cannot maintain dead-reckoned gyro aiding -> Attitude & Heading invalid.
        const ahrsNoAiding = gpsBothFail && iasInvalid;
        const attInvalid = grs1Fail || ahrsNoAiding;
        const attAligning = !attInvalid && ahrsAlign;
        const hdgInvalid = attInvalid || attAligning || gmu1Fail;

        // Approach / Phase context
        let aprCtx;
        if (overrides && typeof overrides === 'object' && (overrides.flightPhase !== undefined || overrides.isApproachActive !== undefined)) {
            const ph = String(overrides.flightPhase || 'ENR').toUpperCase();
            aprCtx = {
                isApproachActive: Boolean(overrides.isApproachActive),
                isVertGuidedApr: Boolean(overrides.isVertGuidedApr),
                isTermOrAprOrDprt: Boolean(overrides.isApproachActive) || (ph !== 'ENR' && ph !== 'OCN')
            };
        } else {
            aprCtx = detectApproachContext(failureRuntime.fms, failureRuntime.cdiScaleLabel);
        }

        const cdiIsGps = (overrides && overrides.cdiIsGps !== undefined) ? Boolean(overrides.cdiIsGps) : failureRuntime.cdiIsGps;
        const cdiNavIndex = (overrides && overrides.cdiNavIndex !== undefined) ? Number(overrides.cdiNavIndex) : failureRuntime.cdiNavIndex;

        // GPS Integrity, Dead Reckoning (DR), & NO GPS POSITION (Section 5.10, pp. 236-237 & Table 2-4, p. 69):
        const gpsLoi = gpsBothFail || raimFail;
        const drMode = gpsBothFail && !aprCtx.isTermOrAprOrDprt && !hdgInvalid && !iasInvalid;
        const noGpsPos = gpsBothFail && !drMode;
        const abortApr = aprCtx.isApproachActive && (gpsBothFail || raimFail) && cdiIsGps;
        const aprDowngrade = aprCtx.isVertGuidedApr && waasFail && !gpsBothFail && !raimFail;
        const gpInhibited = aprDowngrade || (aprCtx.isApproachActive && (gpsBothFail || raimFail));
        const gsInhibited = (!cdiIsGps && cdiNavIndex === 1 && gs1Fail) || (!cdiIsGps && cdiNavIndex === 2 && gs2Fail);

        const cdiNeedleHidden =
            (cdiIsGps && (noGpsPos || (raimFail && aprCtx.isApproachActive))) ||
            (!cdiIsGps && cdiNavIndex === 1 && nav1Fail) ||
            (!cdiIsGps && cdiNavIndex === 2 && nav2Fail);

        // AFCS Status Box Alerts (Table 7-6, p. 369)
        let afcsAlertBadge = '';
        if (afcsPftFail) {
            afcsAlertBadge = 'PFT';
        } else if (gia1Fail || gia2Fail || (gsaPtchFail && gsaRollFail)) {
            afcsAlertBadge = 'AFCS';
        } else if (gsaPtchFail) {
            afcsAlertBadge = 'PTCH';
        } else if (gsaRollFail) {
            afcsAlertBadge = 'ROLL';
        } else if (gsaPtrimFail) {
            afcsAlertBadge = 'PTRM';
        }

        const apMustDisconnect = attInvalid || attAligning || iasInvalid || altInvalid || gia1Fail || gia2Fail || gsaPtchFail || gsaRollFail || afcsPftFail;

        // Reversionary & Display states (Garmin G1000 NXi Pilot's Guide 190-02177-00 Rev. A, p. 10 & p. 117):
        // Failing GDU1 (PFD1) or GDU2 (MFD1) blanks ONLY the failed display (and cascades COM/NAV tuning loss + XTALK ERROR).
        // Reversionary mode on the surviving display is manually activated by pressing the Audio Panel's red DISPLAY BACKUP button.
        const pfdBlanked = gdu1Fail;
        const mfdBlanked = gdu2Fail;
        const pfdReversionary = !pfdBlanked && displayBackup;
        const mfdReversionary = !mfdBlanked && displayBackup;

        // Compute effective 21-bit LRU status mask for Aux - System Status & Telemetry
        let effectiveLruMask = rawLruMask;
        if (com1Fail) effectiveLruMask |= FAIL_LRU_BIT.COM1;
        if (com2Fail) effectiveLruMask |= FAIL_LRU_BIT.COM2;
        if (gps1Fail) effectiveLruMask |= FAIL_LRU_BIT.GPS1;
        if (gps2Fail) effectiveLruMask |= FAIL_LRU_BIT.GPS2;
        if (gs1Fail)  effectiveLruMask |= FAIL_LRU_BIT.GS1;
        if (gs2Fail)  effectiveLruMask |= FAIL_LRU_BIT.GS2;

        return {
            rawLruMask: rawLruMask,
            rawExtraMask: rawExtraMask,
            effectiveLruMask: effectiveLruMask,
            com1Fail: com1Fail,
            com2Fail: com2Fail,
            nav1Fail: nav1Fail,
            nav2Fail: nav2Fail,
            gdc1Fail: gdc1Fail,
            gdl69Fail: gdl69Fail,
            gdu1Fail: gdu1Fail,
            gdu2Fail: gdu2Fail,
            gea1Fail: gea1Fail,
            gia1Fail: gia1Fail,
            gia2Fail: gia2Fail,
            gma1Fail: gma1Fail,
            gmu1Fail: gmu1Fail,
            gps1Fail: gps1Fail,
            gps2Fail: gps2Fail,
            gpsBothFail: gpsBothFail,
            activeGps: activeGps,
            grs1Fail: grs1Fail,
            gs1Fail: gs1Fail,
            gs2Fail: gs2Fail,
            gsaPtchFail: gsaPtchFail,
            gsaRollFail: gsaRollFail,
            gsaPtrimFail: gsaPtrimFail,
            gts800Fail: gts800Fail,
            gtx1Fail: gtx1Fail,
            waasFail: waasFail,
            raimFail: raimFail,
            oatFail: oatFail,
            adcIasFail: adcIasFail,
            adcAltFail: adcAltFail,
            ahrsAlign: ahrsAlign,
            displayBackup: displayBackup,
            com1Ptt: com1Ptt,
            com2Ptt: com2Ptt,
            afcsPftFail: afcsPftFail,
            tawsFail: tawsFail,
            pitotBlocked: pitotBlocked,
            staticBlocked: staticBlocked,
            iasInvalid: iasInvalid,
            altInvalid: altInvalid,
            oatInvalid: oatInvalid,
            tasInvalid: tasInvalid,
            ahrsNoAiding: ahrsNoAiding,
            attInvalid: attInvalid,
            attAligning: attAligning,
            hdgInvalid: hdgInvalid,
            gpsLoi: gpsLoi,
            drMode: drMode,
            noGpsPos: noGpsPos,
            abortApr: abortApr,
            aprDowngrade: aprDowngrade,
            gpInhibited: gpInhibited,
            gsInhibited: gsInhibited,
            cdiNeedleHidden: cdiNeedleHidden,
            afcsAlertBadge: afcsAlertBadge,
            apMustDisconnect: apMustDisconnect,
            pfdBlanked: pfdBlanked,
            mfdBlanked: mfdBlanked,
            pfdReversionary: pfdReversionary,
            mfdReversionary: mfdReversionary,
            cdiIsGps: cdiIsGps,
            cdiNavIndex: cdiNavIndex,
            isApproachActive: aprCtx.isApproachActive
        };
    }

    function buildExpectedSystemAlerts(eff) {
        const alerts = [];
        const push = function (key, title, message) {
            alerts.push({ key: 'wt-fail-' + key, title: title, message: message });
        };

        if (eff.gdu1Fail || eff.gdu2Fail) {
            push('xtalk', 'XTALK ERROR', 'A flight display crosstalk error has occurred.');
            push('gdu-path', 'FAILED PATH', 'A data path has failed.');
        }
        if (eff.gia1Fail) {
            push('gia1', 'GIA1 SERVICE', 'GIA1 needs service. Return the unit for repair.');
            push('gia1-path', 'FAILED PATH', 'GIA1 data path has failed.');
        }
        if (eff.gia2Fail) {
            push('gia2', 'GIA2 SERVICE', 'GIA2 needs service. Return the unit for repair.');
            push('gia2-path', 'FAILED PATH', 'GIA2 data path has failed.');
        }
        if (eff.com1Fail && !eff.gia1Fail && !eff.gdu1Fail) {
            push('com1', 'COM1 SERVICE', 'COM1 needs service. Return unit for repair.');
        }
        if (eff.com2Fail && !eff.gia2Fail && !eff.gdu2Fail) {
            push('com2', 'COM2 SERVICE', 'COM2 needs service. Return unit for repair.');
        }
        if (eff.com1Ptt) {
            push('com1-ptt', 'COM1 PTT', 'COM1 push-to-talk key is stuck.');
        }
        if (eff.com2Ptt) {
            push('com2-ptt', 'COM2 PTT', 'COM2 push-to-talk key is stuck.');
        }
        if (eff.nav1Fail && !eff.gia1Fail && !eff.gdu1Fail) {
            push('nav1', 'NAV1 SERVICE', 'NAV1 needs service. Return unit for repair.');
        }
        if (eff.nav2Fail && !eff.gia2Fail && !eff.gdu2Fail) {
            push('nav2', 'NAV2 SERVICE', 'NAV2 needs service. Return unit for repair.');
        }
        if (eff.gs1Fail && !eff.gia1Fail && !eff.nav1Fail) {
            push('gs1', 'G/S1 FAIL', 'G/S1 is inoperative.');
        }
        if (eff.gs2Fail && !eff.gia2Fail && !eff.nav2Fail) {
            push('gs2', 'G/S2 FAIL', 'G/S2 is inoperative.');
        }
        if (eff.gdc1Fail) {
            push('gdc1', 'GDC1 MANIFEST', 'GDC1 software mismatch, communication halted.');
        }
        if (eff.iasInvalid && !eff.grs1Fail) {
            push('ahrs-tas', 'AHRS1 TAS', 'AHRS1 not receiving airspeed.');
        }
        if (eff.altInvalid && !eff.gtx1Fail) {
            push('xpdr-alt', 'XPDR1 PRES ALT', 'Transponder: ADS-B no pressure altitude.');
        }
        if (eff.oatFail && !eff.gdc1Fail) {
            push('oat', 'GDC1 OAT', 'Outside air temperature probe fault.');
        }
        if (eff.grs1Fail) {
            push('grs1', 'GRS1 MANIFEST', 'GRS1 software mismatch, communication halted.');
        } else if (eff.ahrsNoAiding) {
            push('ahrs-fault', 'AHRS1 FAULT', 'AHRS1 not receiving airspeed or GPS information.');
        }
        if (eff.gmu1Fail && !eff.grs1Fail) {
            push('hdg-fault', 'HDG FAULT', 'AHRS1 magnetometer fault has occurred.');
        }
        if (eff.gea1Fail) {
            push('gea1', 'GEA1 MANIFEST', 'GEA1 software mismatch, communication halted.');
        }
        if (eff.gma1Fail) {
            push('gma1', 'GMA1 FAIL', 'GMA1 is inoperative. Fail-safe audio on COM1.');
        }
        if (eff.gtx1Fail) {
            push('gtx1', 'XPDR1 FAIL', 'XPDR1 is inoperative.');
        }
        if (eff.gdl69Fail) {
            push('gdl69', 'GDL69 FAIL', 'GDL 69 has failed.');
        }
        if (eff.gts800Fail) {
            push('gts800', 'TRAFFIC FAIL', 'Traffic device has failed.');
        }
        if (eff.gpsBothFail) {
            push('gps-lost', 'GPS NAV LOST', 'Loss of GPS navigation. GPS fail.');
            if (!eff.grs1Fail) {
                push('ahrs-no-gps', 'AHRS1 GPS', 'AHRS1 not receiving any GPS information.');
            }
            if (!eff.gtx1Fail) {
                push('xpdr-no-pos', 'XPDR1 ADS-B NO POS', 'Transponder: ADS-B is not transmitting position.');
            }
        } else if (eff.gps1Fail) {
            if (!eff.gia1Fail) {
                push('gps1', 'GPS1 SERVICE', 'GPS1 needs service. Return unit for repair.');
            }
            if (!eff.grs1Fail) {
                push('ahrs-bkp-gps', 'AHRS1 GPS', 'AHRS1 using backup GPS source.');
            }
        } else if (eff.gps2Fail) {
            if (!eff.gia2Fail) {
                push('gps2', 'GPS2 SERVICE', 'GPS2 needs service. Return unit for repair.');
            }
            if (!eff.grs1Fail) {
                push('ahrs-nobkp-gps', 'AHRS1 GPS', 'AHRS1 not receiving backup GPS information.');
            }
        }
        if (eff.raimFail && !eff.gpsBothFail) {
            push('loi', 'LOI', 'GPS integrity lost. Crosscheck with other NAVS.');
        }
        if (eff.abortApr) {
            push('abort-apr', 'ABORT APR', 'Loss of GPS navigation. Abort approach.');
        } else if (eff.aprDowngrade) {
            push('apr-dwngrade', 'APR DWNGRADE', 'Approach downgraded. Use LNAV minimums.');
        }
        if (eff.gsaPtchFail) {
            push('afcs-ptch', 'AFCS PTCH', 'Pitch servo fault. Autopilot inoperative.');
        }
        if (eff.gsaRollFail) {
            push('afcs-roll', 'AFCS ROLL', 'Roll servo fault. Autopilot inoperative.');
        }
        if (eff.gsaPtrimFail) {
            push('ptrm-fail', 'PTRM FAIL', 'Pitch trim servo fault.');
        }
        if (eff.afcsPftFail) {
            push('afcs-pft', 'AFCS PFT', 'AFCS pre-flight test has failed.');
        }
        if (eff.tawsFail) {
            push('taws-fail', 'TERRAIN FAIL', 'Terrain awareness system has failed.');
        }
        return alerts;
    }

    function patchMapDataIntegrityForMod(mod) {
        try {
            if (!mod || !mod.MapDataIntegrityController || !mod.MapDataIntegrityController.prototype) return;
            const proto = mod.MapDataIntegrityController.prototype;
            if (proto.__wtg1000FailPatched) return;
            proto.__wtg1000FailPatched = true;
            const origAfterRender = proto.onAfterMapRender;
            const origDestroy = proto.destroy;
            proto.onAfterMapRender = function () {
                const r = origAfterRender ? origAfterRender.apply(this, arguments) : undefined;
                try {
                    if (this.dataIntegrityModule && failureRuntime.dataIntegrityModules.indexOf(this.dataIntegrityModule) < 0) {
                        failureRuntime.dataIntegrityModules.push(this.dataIntegrityModule);
                        syncMapDataIntegrityModules(computeEffectiveAvionicsFailureState());
                    }
                } catch (e) {}
                return r;
            };
            proto.destroy = function () {
                try {
                    const idx = failureRuntime.dataIntegrityModules.indexOf(this.dataIntegrityModule);
                    if (idx >= 0) failureRuntime.dataIntegrityModules.splice(idx, 1);
                } catch (e) {}
                return origDestroy ? origDestroy.apply(this, arguments) : undefined;
            };
        } catch (e) {}
    }

    function patchMapDataIntegrityForFailures() {
        try {
            const mods = [window.g1000nxipfd, window.g1000nximfd, failureRuntime.mfdRevPfdMod];
            for (let m = 0; m < mods.length; m++) {
                patchMapDataIntegrityForMod(mods[m]);
            }
        } catch (e) {}
    }

    function syncMapDataIntegrityModules(eff) {
        const list = failureRuntime.dataIntegrityModules;
        for (let i = 0; i < list.length; i++) {
            const dm = list[i];
            if (!dm) continue;
            try {
                if (dm.gpsSignalValid && typeof dm.gpsSignalValid.set === 'function') {
                    dm.gpsSignalValid.set(!eff.noGpsPos);
                }
                if (dm.headingSignalValid && typeof dm.headingSignalValid.set === 'function') {
                    dm.headingSignalValid.set(!eff.hdgInvalid);
                }
                if (dm.attitudeSignalValid && typeof dm.attitudeSignalValid.set === 'function') {
                    dm.attitudeSignalValid.set(!eff.attInvalid && !eff.attAligning);
                }
                if (dm.adcSignalValid && typeof dm.adcSignalValid.set === 'function') {
                    dm.adcSignalValid.set(!eff.iasInvalid && !eff.altInvalid);
                }
            } catch (e) {}
        }
    }

    function ensureFailureSystemDomStyles() {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById('wt-g1000-failure-styles')) return;
        const st = document.createElement('style');
        st.id = 'wt-g1000-failure-styles';
        st.textContent =
            '.wt-redx-box {' +
            '  position:absolute; box-sizing:border-box; z-index:180; pointer-events:none;' +
            '  background-color:rgba(0,0,0,0.88); border:1px solid rgba(255,255,255,0.45);' +
            '  background-image: linear-gradient(to top right, transparent calc(50% - 1.4px), #ff1e1e, transparent calc(50% + 1.4px)),' +
            '                    linear-gradient(to top left, transparent calc(50% - 1.4px), #ff1e1e, transparent calc(50% + 1.4px));' +
            '  display:flex; align-items:center; justify-content:center; font-family:Roboto-Bold,Roboto,sans-serif;' +
            '}' +
            '#wt-xpdr-fail-box {' +
            '  left:0; top:0; width:100%; height:100%; z-index:190; color:#ffd800; font-size:15px; font-weight:bold; letter-spacing:0.4px;' +
            '}' +
            '#wt-tas-fail-box {' +
            '  left:0; bottom:0; width:100%; height:26px; z-index:190;' +
            '}' +
            '#wt-vdev-fail-box {' +
            '  left:0; top:0; width:100%; height:100%; z-index:190; color:#ffd800; font-size:12px; font-weight:bold; text-align:center;' +
            '}' +
            '#wt-afcs-fail-badge {' +
            '  position:absolute; left:2px; top:1px; right:2px; height:22px; z-index:195;' +
            '  background:#000; border:1px solid #ff2222; color:#ff2222; font-size:16px; font-weight:bold;' +
            '  display:flex; align-items:center; justify-content:center; letter-spacing:0.5px; pointer-events:none;' +
            '}' +
            '#wt-hsi-dr-badge {' +
            '  position:absolute; left:132px; top:198px; z-index:185; padding:1px 5px;' +
            '  background:rgba(0,0,0,0.82); border:1px solid #ffbf00; border-radius:3px;' +
            '  color:#ffbf00; font-size:16px; font-weight:bold; pointer-events:none;' +
            '}' +
            '.wt-map-dr-badge {' +
            '  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:185; padding:0px 4px;' +
            '  background:rgba(0,0,0,0.82); border:1px solid #ffbf00; border-radius:3px;' +
            '  color:#ffbf00; font-size:14px; font-weight:bold; pointer-events:none;' +
            '}' +
            '#wt-taws-banner {' +
            '  position:absolute; left:232px; top:226px; z-index:185; padding:1px 6px;' +
            '  background:rgba(0,0,0,0.82); border:1px solid #ffbf00; border-radius:3px;' +
            '  color:#ffbf00; font-size:14px; font-weight:bold; pointer-events:none;' +
            '}' +
            '#wt-gma1-banner {' +
            '  position:absolute; right:8px; top:56px; z-index:188; padding:1px 6px;' +
            '  background:rgba(0,0,0,0.88); border:1px solid #ffbf00; color:#ffbf00; font-size:12px; font-weight:bold; pointer-events:none;' +
            '}' +
            '.wt-ptt-stuck-badge {' +
            '  position:absolute; right:4px; top:2px; z-index:188; padding:0 4px;' +
            '  background:#ff1e1e; color:#fff; font-size:11px; font-weight:bold; border-radius:2px; pointer-events:none;' +
            '}' +
            '#wt-eis-fail-overlay {' +
            '  position:absolute; left:0; top:0; width:100%; height:100%; z-index:210; pointer-events:none;' +
            '  background:rgba(8,10,14,0.92); padding:6px 4px; box-sizing:border-box; display:flex; flex-direction:column; gap:6px;' +
            '}' +
            '.wt-eis-fail-cell {' +
            '  position:relative; flex:1; border:1px solid rgba(255,255,255,0.38); background:#050608;' +
            '  background-image: linear-gradient(to top right, transparent calc(50% - 1.5px), #ff1e1e, transparent calc(50% + 1.5px)),' +
            '                    linear-gradient(to top left, transparent calc(50% - 1.5px), #ff1e1e, transparent calc(50% + 1.5px));' +
            '  display:flex; align-items:flex-start; justify-content:space-between; padding:3px 5px; color:#c8d0dc; font-size:11px; font-weight:bold;' +
            '}' +
            '#wt-gdu-poweroff-overlay {' +
            '  position:fixed; left:0; top:0; width:100vw; height:100vh; z-index:99999; background:#020203;' +
            '  display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.08); font-size:13px; pointer-events:all;' +
            '}' +
            'body.wt-dr-amber-mode .FixDistValue, body.wt-dr-amber-mode .FixBrgValue,' +
            'body.wt-dr-amber-mode .nav-data-bar-field-model-value, body.wt-dr-amber-mode #HSI .dtk-box span.size20,' +
            'body.wt-dr-amber-mode .wind-overlay div, body.wt-dr-amber-mode .wind-overlay span {' +
            '  color:#ffbf00 !important;' +
            '}' +
            'body.wt-cdi-needle-hidden .hsi-rose-needle-deviation, body.wt-cdi-needle-hidden .hsi-map-deviation,' +
            'body.wt-cdi-needle-hidden .xtk-deviation, body.wt-cdi-needle-hidden #HSI [class*="deviation"] {' +
            '  visibility:hidden !important;' +
            '}';
        document.head.appendChild(st);
    }

    function setOrRemoveOverlay(parent, id, className, htmlText, show) {
        if (!parent) return;
        let el = document.getElementById(id);
        if (!show) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
            return;
        }
        const computedPos = (typeof window.getComputedStyle === 'function') ? window.getComputedStyle(parent).position : '';
        if (!computedPos || computedPos === 'static') {
            parent.style.position = 'relative';
        }
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.className = className;
            parent.appendChild(el);
        } else if (el.parentNode !== parent) {
            parent.appendChild(el);
        }
        if (el.innerHTML !== htmlText) {
            el.innerHTML = htmlText;
        }
    }

    function splitCssSelectorsTopLevel(selectorText) {
        const out = [];
        let cur = '';
        let paren = 0;
        let bracket = 0;
        for (let i = 0; i < selectorText.length; i++) {
            const ch = selectorText.charAt(i);
            if (ch === '(') paren++;
            else if (ch === ')' && paren > 0) paren--;
            else if (ch === '[') bracket++;
            else if (ch === ']' && bracket > 0) bracket--;
            if (ch === ',' && paren === 0 && bracket === 0) {
                out.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        if (cur) out.push(cur);
        return out;
    }

    function scopePfdCssBlockList(cleanCss) {
        const chunks = [];
        const len = cleanCss.length;
        let pos = 0;
        while (pos < len) {
            while (pos < len && /\s/.test(cleanCss.charAt(pos))) pos++;
            if (pos >= len) break;
            const headerStart = pos;
            let braceOpen = -1;
            let semiPos = -1;
            let paren = 0;
            let quote = '';
            while (pos < len) {
                const ch = cleanCss.charAt(pos);
                if (quote) {
                    if (ch === '\\') pos++;
                    else if (ch === quote) quote = '';
                } else if (ch === '"' || ch === '\'') {
                    quote = ch;
                } else if (ch === '(') {
                    paren++;
                } else if (ch === ')' && paren > 0) {
                    paren--;
                } else if (paren === 0 && ch === '{') {
                    braceOpen = pos;
                    break;
                } else if (paren === 0 && ch === ';' && cleanCss.charAt(headerStart) === '@') {
                    semiPos = pos;
                    break;
                }
                pos++;
            }
            if (semiPos >= 0) {
                pos = semiPos + 1;
                continue;
            }
            if (braceOpen < 0) break;
            const rawHeader = cleanCss.slice(headerStart, braceOpen).trim();
            pos = braceOpen + 1;
            const bodyStart = pos;
            let depth = 1;
            quote = '';
            while (pos < len && depth > 0) {
                const ch = cleanCss.charAt(pos);
                if (quote) {
                    if (ch === '\\') pos++;
                    else if (ch === quote) quote = '';
                } else if (ch === '"' || ch === '\'') {
                    quote = ch;
                } else if (ch === '{') {
                    depth++;
                } else if (ch === '}') {
                    depth--;
                    if (depth === 0) break;
                }
                pos++;
            }
            const rawBody = cleanCss.slice(bodyStart, pos);
            if (pos < len && cleanCss.charAt(pos) === '}') pos++;

            if (!rawHeader) continue;
            if (rawHeader.charAt(0) === '@') {
                if (/^@(font-face|keyframes|-webkit-keyframes)\b/i.test(rawHeader)) {
                    chunks.push(rawHeader + ' {' + rawBody + '}');
                } else if (/^@media\b/i.test(rawHeader)) {
                    chunks.push(rawHeader + ' {\n' + scopePfdCssBlockList(rawBody) + '\n}');
                }
                continue;
            }

            const rawSels = splitCssSelectorsTopLevel(rawHeader);
            const kept = [];
            for (let s = 0; s < rawSels.length; s++) {
                let sel = rawSels[s].replace(/\s+/g, ' ').trim();
                if (!sel) continue;
                // Keep MFD's own native EIS, NavCom, and SoftKey container styling untouched
                if (/^\.eis(\b|$)/.test(sel)) continue;
                if (/\.navcom-/.test(sel)) continue;
                if (/#NavComBox\s+#(Left|Right)\b/.test(sel)) continue;
                if (/^\.softkeys-container\b/.test(sel)) continue;

                sel = sel.replace(/\bwtg1000-pfd\b/g, 'wtg1000-mfd');
                sel = sel.replace(/^(:root|html\s+body|html|body)(?=[\s.#:\[,>+~]|$)/i, 'body.wt-mfd-reversionary-active');
                if (sel.indexOf('body.wt-mfd-reversionary-active') !== 0) {
                    sel = 'body.wt-mfd-reversionary-active ' + sel;
                }
                kept.push(sel);
            }
            if (kept.length > 0) {
                chunks.push(kept.join(', ') + ' {' + rawBody + '}');
            }
        }
        return chunks.join('\n');
    }

    function scopePfdCssForMfdReversionary(cssText) {
        const cleanCss = String(cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
        const preRules =
            'body.wt-mfd-reversionary-active .popout-dialog { top: auto; padding: 0; }\n';
        const scopedCore = scopePfdCssBlockList(cleanCss);
        const postRules = [
            '',
            'body:not(.wt-mfd-reversionary-active) #HorizonContainer,',
            'body:not(.wt-mfd-reversionary-active) #wt-mfd-rev-instruments,',
            'body:not(.wt-mfd-reversionary-active) #cas,',
            'body:not(.wt-mfd-reversionary-active) #warnings,',
            'body:not(.wt-mfd-reversionary-active) #NavComBoxCenter {',
            '  display: none !important;',
            '}',
            'body.wt-mfd-reversionary-active .mfd-page,',
            'body.wt-mfd-reversionary-active .wt-aux-fullpage,',
            'body.wt-mfd-reversionary-active .wt-custom-pane,',
            'body.wt-mfd-reversionary-active #NavComBox .nav-data-bar-container {',
            '  display: none !important;',
            '}',
            'body.wt-mfd-reversionary-active wtg1000-mfd #Mainframe #HorizonContainer {',
            '  z-index: 0 !important;',
            '}',
            'body.wt-mfd-reversionary-active #wt-mfd-rev-instruments {',
            '  position: absolute; left: 0px; top: 0px; width: 1024px; height: 733px; pointer-events: none;',
            '}',
            'body.wt-mfd-reversionary-active .bip-temp-box {',
            '  left: 152px !important; z-index: 20 !important;',
            '}',
            'body.wt-mfd-reversionary-active .map-inset {',
            '  left: unset !important; right: 0px !important; width: 312px !important;',
            '}',
            'body.wt-mfd-reversionary-active .map-inset .pfd-insetmap {',
            '  width: 312px !important;',
            '}'
        ].join('\n');
        return preRules + scopedCore + postRules;
    }

    function patchPfdJsForMfdReversionary(pfdJsText) {
        let code = String(pfdJsText || '');
        // Isolate Bing map instance IDs so MFD Reversionary SVT / HSI Map / Inset Map never collide with PFD
        code = code.replace(/bingId:\s*['"]wtg1000-horizon['"]/g, "bingId: 'mfd-rev-horizon'");
        code = code.replace(/bingId:\s*['"]pfd-map['"]/g, "bingId: 'mfd-rev-pfd-map'");
        // Prevent PFD's 1000ms mfd_power_on / vc_screen_state non-reversionary reset timers from clearing .reversionary or Engine softkey on MFD
        code = code.replace(/'mfd_power_on'/g, "'wt_mfd_rev_ignore_power'");
        // Map MFD physical bezel controls (RANGE, JOYSTICK, FMS knobs, FPL, PROC, D->, MENU, ENT, CLR, XPDR) to Reversionary PFD components
        code = code.replace(/AS1000_PFD_RANGE_(INC|DEC)/g, 'AS1000_MFD_RANGE_$1');
        code = code.replace(/AS1000_PFD_JOYSTICK_(PUSH|LEFT|UP|RIGHT|DOWN)/g, 'AS1000_MFD_JOYSTICK_$1');
        code = code.replace(/AS1000_PFD_FMS_(Upper_INC|Upper_DEC|Lower_INC|Lower_DEC|Upper_PUSH)/g, 'AS1000_MFD_FMS_$1');
        code = code.replace(/AS1000_PFD_XPDR_(Small_INC|Small_DEC|Large_INC|Large_DEC)/g, 'AS1000_MFD_XPDR_$1');
        code = code.replace(/'AS1000_PFD_MENU_Push'/g, "'AS1000_MFD_MENU_Push'");
        code = code.replace(/'AS1000_PFD_CLR'/g, "'AS1000_MFD_CLR'");
        code = code.replace(/'AS1000_PFD_ENT_Push'/g, "'AS1000_MFD_ENT_Push'");
        code = code.replace(/'AS1000_PFD_DIRECTTO'/g, "'AS1000_MFD_DIRECTTO'");
        code = code.replace(/'AS1000_PFD_FPL_Push'/g, "'AS1000_MFD_FPL_Push'");
        code = code.replace(/'AS1000_PFD_PROC_Push'/g, "'AS1000_MFD_PROC_Push'");
        return code;
    }

    function mountMfdReversionaryComponentsWithSources(pfdCssText, pfdJsText) {
        if (failureRuntime.mfdRevMounted) return true;
        if (typeof document === 'undefined' || !document.body || !document.head) return false;
        const mfd = document.querySelector('wtg1000-mfd');
        const garmin = window.garminsdk;
        if (!mfd || !mfd.bus || !mfd.planner || !mfd.fms || !mfd.airframeOptions || !sdk || !garmin) {
            return false;
        }
        // 1. Inject scoped PFD.css
        if (!document.getElementById('wt-mfd-pfd-scoped-css')) {
            const st = document.createElement('style');
            st.id = 'wt-mfd-pfd-scoped-css';
            st.textContent = scopePfdCssForMfdReversionary(pfdCssText);
            document.head.appendChild(st);
        }
        // 2. Evaluate patched PFD.js in isolated closure (no global registerInstrument or window.g1000nxipfd side-effects)
        const patchedJs = patchPfdJsForMfdReversionary(pfdJsText);
        const evalFn = new Function('msfssdk', 'garminsdk', 'registerInstrument', patchedJs + '\nreturn g1000nxipfd;');
        const pfdMod = evalFn(sdk, garmin, function () {});
        if (!pfdMod || !pfdMod.PrimaryHorizonDisplay || !pfdMod.HSI) {
            return false;
        }
        failureRuntime.mfdRevPfdMod = pfdMod;
        patchMapDataIntegrityForMod(pfdMod);
        // 3. Create PFD DOM containers inside MFD's #Electricity & #InstrumentsContainer
        const elecEl = document.getElementById('Electricity');
        const instrEl = document.getElementById('InstrumentsContainer');
        const navComEl = document.getElementById('NavComBox');
        if (!elecEl || !instrEl || !navComEl) {
            return false;
        }

        let horizonEl = document.getElementById('HorizonContainer');
        if (!horizonEl) {
            horizonEl = document.createElement('div');
            horizonEl.id = 'HorizonContainer';
            elecEl.insertBefore(horizonEl, instrEl);
        }

        let revInstrEl = document.getElementById('wt-mfd-rev-instruments');
        if (!revInstrEl) {
            revInstrEl = document.createElement('div');
            revInstrEl.id = 'wt-mfd-rev-instruments';
            const softKeysEl = document.getElementById('SoftKeys');
            if (softKeysEl && softKeysEl.parentNode === instrEl) {
                instrEl.insertBefore(revInstrEl, softKeysEl);
            } else {
                instrEl.appendChild(revInstrEl);
            }
        }

        let casEl = document.getElementById('cas');
        if (!casEl) {
            casEl = document.createElement('div');
            casEl.id = 'cas';
            instrEl.appendChild(casEl);
        }
        let warnEl = document.getElementById('warnings');
        if (!warnEl) {
            warnEl = document.createElement('div');
            warnEl.id = 'warnings';
            instrEl.appendChild(warnEl);
        }
        // 4. Construct PFD-specific backplane instruments & controllers on MFD's bus
        // Note: NavIndicatorController must defer initial cached bus notifications until HSI/VDI/FMA refs are rendered!
        const bus = mfd.bus;
        const navProc = new sdk.NavProcessor(bus, new pfdMod.NPConfig(bus, mfd.planner));
        const xpdrInst = new sdk.XPDRInstrument(bus);
        const ctrlSurfPub = sdk.ControlSurfacesPublisher ? new sdk.ControlSurfacesPublisher(bus, 3) : null;
        const casXmlLogicHost = new sdk.CompositeLogicXMLHost();
        const alertsSubj = new pfdMod.AlertsSubject(bus);
        if (pfdMod.CasAlertsBridge) {
            try { new pfdMod.CasAlertsBridge(bus); } catch (e) {}
        }
        const deferredNavSubs = [];
        const deferredNavBus = {
            on: function (topic, handler, paused) {
                const sub = bus.on(topic, handler, true);
                if (!paused) {
                    deferredNavSubs.push(sub);
                }
                return sub;
            },
            off: function (topic, handler) {
                return bus.off(topic, handler);
            },
            pub: function (topic, data, sync, cached) {
                return bus.pub(topic, data, sync, cached);
            },
            getSubscriber: function () {
                return new sdk.EventSubscriber(deferredNavBus);
            },
            getPublisher: function () {
                return bus.getPublisher();
            }
        };
        const navIndCtrl = new garmin.NavIndicatorController(deferredNavBus, mfd.fms);
        navIndCtrl.bus = bus;
        const iasDataProvider = new pfdMod.G1000AirspeedIndicatorDataProvider(bus, mfd.airframeOptions.airspeedIndicatorConfig);
        const vSpeedMgr = new pfdMod.VSpeedUserSettingManager(bus, mfd.airframeOptions.vSpeedGroups);

        // 5. Render 100% genuine Working Title PFD components (Figure 1-5 Reversionary Mode layout)
        const FS = sdk.FSComponent;
        const hsiRef = FS.createRef();
        const mapInsetRef = FS.createRef();
        const bipRef = FS.createRef();
        failureRuntime.mfdRevHsiRef = hsiRef;
        failureRuntime.mfdRevMapInsetRef = mapInsetRef;
        failureRuntime.mfdRevBipRef = bipRef;

        FS.render(FS.buildComponent(pfdMod.PrimaryHorizonDisplay, {
            bus: bus,
            fms: mfd.fms,
            flightPlanner: mfd.planner,
            hasRadioAltimeter: mfd.airframeOptions.hasRadioAltimeter
        }), horizonEl);
        FS.render(FS.buildComponent(pfdMod.HSI, {
            ref: hsiRef,
            bus: bus,
            flightPlanner: mfd.planner,
            navIndicatorController: navIndCtrl,
            tas: mfd.tas,
            unitsSettingManager: garmin.UnitsUserSettings.getManager(bus)
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.FlightDirector, { bus: bus }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.G1000AirspeedIndicator, {
            dataProvider: iasDataProvider,
            config: mfd.airframeOptions.airspeedIndicatorConfig,
            vSpeedSettingManager: vSpeedMgr,
            declutter: sdk.Subject.create(false)
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.VerticalSpeedIndicator, {
            bus: bus,
            navIndicatorController: navIndCtrl
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.Altimeter, {
            bus: bus,
            g1000Publisher: mfd.g1000ControlPublisher,
            hasRadioAltimeter: mfd.airframeOptions.hasRadioAltimeter
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.MarkerBeacon, { bus: bus }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.DMEWindow, { bus: bus, navIndicatorController: navIndCtrl }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.VerticalDeviation, { bus: bus, navIndicatorController: navIndCtrl }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.Fma, {
            bus: bus,
            planner: mfd.planner,
            navController: navIndCtrl
        }), navComEl);
        FS.render(FS.buildComponent(pfdMod.BottomInfoPanel, {
            ref: bipRef,
            bus: bus,
            controlPublisher: mfd.controlPublisher,
            unitsSettingManager: garmin.UnitsUserSettings.getManager(bus)
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.WindOverlay, { bus: bus }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.MapInset, {
            ref: mapInsetRef,
            bus: bus,
            flightPlanner: mfd.planner,
            tas: mfd.tas
        }), revInstrEl);
        FS.render(FS.buildComponent(pfdMod.CAS, {
            bus: bus,
            logicHandler: casXmlLogicHost,
            annunciations: mfd.airframeOptions.annunciationConfig,
            cautionSoundId: 'tone_caution',
            warningSoundId: 'tone_warning'
        }), casEl);
        FS.render(FS.buildComponent(pfdMod.WarningDisplay, {
            bus: bus,
            logicHandler: casXmlLogicHost,
            warnings: mfd.airframeOptions.warningConfig
        }), warnEl);

        // 5b. Now that HSI, VDI, DMEWindow, VSI, and FMA refs are mounted, resume NavIndicatorController subscriptions & init backplane instruments
        for (let i = 0; i < deferredNavSubs.length; i++) {
            try { deferredNavSubs[i].resume(true); } catch (e) {}
        }
        navProc.init();
        try {
            if (typeof SimVar !== 'undefined') {
                const gpsDrives = Number(SimVar.GetSimVarValue('GPS DRIVES NAV1', 'Bool') || 0) > 0;
                const navSel = Number(SimVar.GetSimVarValue('AUTOPILOT NAV SELECTED', 'Number') || 1);
                if (!gpsDrives && navSel === 2 && typeof navProc.switchCdiSrc === 'function') {
                    navProc.switchCdiSrc(1);
                }
            }
        } catch (e) {}
        xpdrInst.init();
        if (ctrlSurfPub) {
            if (typeof ctrlSurfPub.init === 'function') ctrlSurfPub.init();
            if (typeof ctrlSurfPub.startPublish === 'function') ctrlSurfPub.startPublish();
        }
        iasDataProvider.init();

        // Drive NavProcessor, XPDRInstrument, ControlSurfacesPublisher, and CAS XML logic on MFD's update loop
        bus.getSubscriber().on('simTimeHiFreq').handle(function () {
            try { navProc.onUpdate(); } catch (e) {}
            try { xpdrInst.onUpdate(); } catch (e) {}
            try { if (ctrlSurfPub) ctrlSurfPub.onUpdate(); } catch (e) {}
            try { if (failureRuntime.mfdReversionaryActive) casXmlLogicHost.update(mfd.deltaTime || 33); } catch (e) {}
        });

        // Ensure DA/MDA altitude units match user settings
        try {
            garmin.UnitsUserSettings.getManager(bus).altitudeUnits.sub(function (u) {
                const minsPub = bus.getPublisher();
                if (u === sdk.UnitType.FOOT) minsPub.pub('set_da_distance_unit', 'feet', true, true);
                else if (u === sdk.UnitType.METER) minsPub.pub('set_da_distance_unit', 'meters', true, true);
            }, true);
        } catch (e) {}

        // 6. Initialize isolated Reversionary PFDViewService on MFD (active ONLY while mfdReversionaryActive === true)
        if (pfdMod.PFDViewService) {
            const revVs = new pfdMod.PFDViewService(bus);
            const origRevInteraction = revVs.onInteractionEvent.bind(revVs);
            revVs.onInteractionEvent = function (hEvt) {
                if (!failureRuntime.mfdReversionaryActive) return false;
                return origRevInteraction(hEvt);
            };
            if (mfd.viewService && !mfd.viewService.__wtRevGuarded) {
                mfd.viewService.__wtRevGuarded = true;
                const origMfdInteraction = mfd.viewService.onInteractionEvent.bind(mfd.viewService);
                mfd.viewService.onInteractionEvent = function (hEvt) {
                    if (failureRuntime.mfdReversionaryActive) return false;
                    return origMfdInteraction(hEvt);
                };
            }
            const facLoader = mfd.loader || new sdk.FacilityLoader(sdk.FacilityRepository.getRepository(bus));
            revVs.registerView('FPL', function () { return FS.buildComponent(pfdMod.FPL, { viewService: revVs, bus: bus, fms: mfd.fms, title: 'Flight Plan', showTitle: true }); });
            revVs.registerView('PROC', function () { return FS.buildComponent(pfdMod.PFDProc, { viewService: revVs, title: 'Procedures', showTitle: true, fms: mfd.fms }); });
            revVs.registerView('DirectTo', function () { return FS.buildComponent(pfdMod.PFDDirectTo, { viewService: revVs, bus: bus, fms: mfd.fms, title: 'Direct To', showTitle: true }); });
            revVs.registerView('WptInfo', function () { return FS.buildComponent(pfdMod.PFDWptInfo, { viewService: revVs, bus: bus, title: 'Waypoint Information', showTitle: true }); });
            revVs.registerView('MessageDialog', function () { return FS.buildComponent(pfdMod.MessageDialog, { viewService: revVs, title: '', showTitle: false }); });
            revVs.registerView('SetRunway', function () { return FS.buildComponent(pfdMod.PFDSetRunway, { viewService: revVs, title: 'Set Runway', showTitle: true }); });
            revVs.registerView('SelectDeparture', function () { return FS.buildComponent(pfdMod.PFDSelectDepartureView, { viewService: revVs, bus: bus, fms: mfd.fms, calculator: mfd.calculator, title: 'Select Departure', showTitle: true }); });
            revVs.registerView('SelectApproach', function () { return FS.buildComponent(pfdMod.PFDSelectApproachView, { viewService: revVs, bus: bus, fms: mfd.fms, calculator: mfd.calculator, title: 'Select Approach', showTitle: true, hasRadioAltimeter: mfd.airframeOptions.hasRadioAltimeter }); });
            revVs.registerView('SelectArrival', function () { return FS.buildComponent(pfdMod.PFDSelectArrivalView, { viewService: revVs, bus: bus, fms: mfd.fms, calculator: mfd.calculator, title: 'Select Arrival', showTitle: true }); });
            revVs.registerView(pfdMod.ContextMenuDialog.name, function () { return FS.buildComponent(pfdMod.ContextMenuDialog, { viewService: revVs, title: '', showTitle: false, upperKnobCanScroll: true }); });
            revVs.registerView('PageMenuDialog', function () { return FS.buildComponent(pfdMod.PFDPageMenuDialog, { viewService: revVs, title: 'Page Menu', showTitle: true }); });
            revVs.registerView(pfdMod.TimerRef.name, function () { return FS.buildComponent(pfdMod.TimerRef, { viewService: revVs, title: 'TimerRef', showTitle: false, bus: bus, vSpeedSettingManager: vSpeedMgr, unitsSettingManager: garmin.UnitsUserSettings.getManager(bus), hasRadioAltimeter: mfd.airframeOptions.hasRadioAltimeter }); });
            revVs.registerView(pfdMod.ADFDME.name, function () { return FS.buildComponent(pfdMod.ADFDME, { viewService: revVs, bus: bus, title: 'ADF/DME TUNING', showTitle: true, navIndicatorController: navIndCtrl }); });
            revVs.registerView('WptDup', function () { return FS.buildComponent(pfdMod.PFDWptDupDialog, { viewService: revVs, title: 'Duplicate Waypoints', showTitle: true }); });
            revVs.registerView(pfdMod.Nearest.name, function () { return FS.buildComponent(pfdMod.Nearest, { viewService: revVs, bus: bus, loader: facLoader, publisher: mfd.controlPublisher, title: 'Nearest Airports', showTitle: true }); });
            revVs.registerView(pfdMod.PFDSetup.name, function () { return FS.buildComponent(pfdMod.PFDSetup, { viewService: revVs, title: 'PFD Setup Menu', showTitle: true, bus: bus }); });
            revVs.registerView(pfdMod.Alerts.name, function () { return FS.buildComponent(pfdMod.Alerts, { data: alertsSubj, viewService: revVs, title: 'Alerts', showTitle: true }); });
            revVs.registerView('SelectAirway', function () { return FS.buildComponent(pfdMod.PFDSelectAirway, { viewService: revVs, title: 'Select Airway', showTitle: true, fms: mfd.fms }); });
            revVs.registerView('HoldAt', function () { return FS.buildComponent(pfdMod.PFDHold, { viewService: revVs, title: 'Hold at', showTitle: true, fms: mfd.fms, bus: bus }); });
            failureRuntime.mfdRevViewService = revVs;
        }

        // 7. Register Reversionary PFD SoftKey menus on MFD's SoftKeyMenuSystem
        const menuSys = (failureRuntime.binder && failureRuntime.binder.menuSystem) || pluginMenuSystem;
        if (menuSys && typeof menuSys.addMenu === 'function') {
            const revRoot = new pfdMod.RootMenu(menuSys, mfd.controlPublisher, mfd.g1000ControlPublisher, bus);
            revRoot.getItem(0).label.set('Engine');
            revRoot.getItem(0).handler = function () { menuSys.pushMenu('engine-menu'); };
            if (pfdMod.PFDUserSettings && pfdMod.PfdMapLayoutSettingMode) {
                const mapLayoutSetting = pfdMod.PFDUserSettings.getManager(bus).getSetting('mapLayout');
                revRoot.getItem(2).handler = function () {
                    mapLayoutSetting.value = (mapLayoutSetting.value === pfdMod.PfdMapLayoutSettingMode.TFC)
                        ? pfdMod.PfdMapLayoutSettingMode.Inset
                        : pfdMod.PfdMapLayoutSettingMode.TFC;
                };
            }
            failureRuntime.mfdRevRootMenu = revRoot;
            menuSys.addMenu('rev-pfd-root', revRoot);
            menuSys.addMenu('map-hsi', new pfdMod.MapHSIMenu(menuSys));
            menuSys.addMenu('map-hsi-layout', new pfdMod.MapHSILayoutMenu(menuSys));
            menuSys.addMenu('pfd-opt', new pfdMod.PFDOptMenu(menuSys, mfd.controlPublisher, mfd.g1000ControlPublisher, bus));
            menuSys.addMenu('svt', new pfdMod.SVTMenu(menuSys));
            menuSys.addMenu('wind', new pfdMod.WindMenu(menuSys));
            menuSys.addMenu('alt-units', new pfdMod.ALTUnitsMenu(menuSys));
            menuSys.addMenu('xpdr', new pfdMod.XPDRMenu(menuSys, mfd.controlPublisher, mfd.g1000ControlPublisher, bus));
            menuSys.addMenu('xpdr-code', new pfdMod.XPDRCodeMenu(menuSys, bus, mfd.g1000ControlPublisher));
        }

        // Sync radio states & active CDI source immediately
        try {
            mfd.controlPublisher.publishEvent('publish_radio_states', true);
            mfd.controlPublisher.publishEvent('init_cdi', true);
        } catch (e) {}

        // Replay existing alerts into MFD's AlertsSubject so Alerts softkey & popup are populated immediately
        try {
            const pub = bus.getPublisher();
            const curEff = computeEffectiveAvionicsFailureState();
            const alerts = buildExpectedSystemAlerts(curEff);
            for (let i = 0; i < alerts.length; i++) {
                pub.pub('alerts_push', { key: alerts[i].key, title: alerts[i].title, message: alerts[i].message }, true, false);
            }
        } catch (e) {}

        failureRuntime.mfdRevMounted = true;
        return true;
    }

    function fetchTextFileViaXhr(url, onDone) {
        try {
            if (typeof XMLHttpRequest === 'undefined') {
                onDone(null);
                return;
            }
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText)) {
                        onDone(xhr.responseText);
                    } else {
                        onDone(null);
                    }
                }
            };
            xhr.onerror = function () { onDone(null); };
            xhr.send();
        } catch (e) {
            onDone(null);
        }
    }

    function ensureMfdNativeReversionaryMounted(onReady) {
        if (failureRuntime.mfdRevMounted) {
            if (typeof onReady === 'function') onReady(true);
            return;
        }
        if (typeof onReady === 'function') {
            failureRuntime.mfdRevCallbacks.push(onReady);
        }
        if (failureRuntime.mfdRevLoading) return;
        failureRuntime.mfdRevLoading = true;

        const finishAll = function (ok) {
            failureRuntime.mfdRevLoading = false;
            const cbs = failureRuntime.mfdRevCallbacks.slice();
            failureRuntime.mfdRevCallbacks.length = 0;
            for (let i = 0; i < cbs.length; i++) {
                try { cbs[i](ok); } catch (e) {}
            }
        };

        fetchTextFileViaXhr('/Pages/VCockpit/Instruments/NavSystems/WTG1000/PFD/PFD.css', function (cssText) {
            if (!cssText) {
                finishAll(false);
                return;
            }
            fetchTextFileViaXhr('/Pages/VCockpit/Instruments/NavSystems/WTG1000/PFD/PFD.js', function (jsText) {
                if (!jsText) {
                    finishAll(false);
                    return;
                }
                let ok = false;
                try {
                    ok = mountMfdReversionaryComponentsWithSources(cssText, jsText);
                } catch (e) {
                    console.error('WTG1000NxiEnhancements: mountMfdReversionaryComponentsWithSources error', e);
                }
                finishAll(ok);
            });
        });
    }

    function syncMfdNativeReversionaryMode(eff) {
        if (!failureRuntime.isMfd || typeof document === 'undefined' || !document.body) return;
        const wantRev = Boolean(eff.mfdReversionary);
        if (!wantRev && !failureRuntime.mfdReversionaryActive) {
            return;
        }
        if (wantRev && failureRuntime.mfdReversionaryActive && failureRuntime.mfdRevMounted) {
            return;
        }

        const mfd = typeof document.querySelector === 'function' ? document.querySelector('wtg1000-mfd') : null;
        const menuSys = (failureRuntime.binder && failureRuntime.binder.menuSystem) || pluginMenuSystem;

        if (!wantRev) {
            failureRuntime.mfdReversionaryActive = false;
            if (document.body.classList) {
                document.body.classList.remove('wt-mfd-reversionary-active');
            }
            if (typeof document.body.removeAttribute === 'function') {
                document.body.removeAttribute('reversionary');
            }
            try {
                if (failureRuntime.mfdRevViewService) {
                    failureRuntime.mfdRevViewService.clearStack(true);
                }
                if (failureRuntime.mfdRevMapInsetRef && failureRuntime.mfdRevMapInsetRef.instance) {
                    failureRuntime.mfdRevMapInsetRef.instance.setVisible(false);
                }
                if (failureRuntime.mfdRevHsiRef && failureRuntime.mfdRevHsiRef.instance && failureRuntime.mfdRevHsiRef.instance.mapRef && failureRuntime.mfdRevHsiRef.instance.mapRef.instance) {
                    failureRuntime.mfdRevHsiRef.instance.mapRef.instance.setVisible(false);
                }
            } catch (e) {}
            try {
                if (menuSys && typeof menuSys.clear === 'function') {
                    menuSys.clear();
                    menuSys.pushMenu('navmap-root');
                }
                if (mfd && mfd.viewService && typeof mfd.viewService.open === 'function') {
                    mfd.viewService.open(failureRuntime.mfdSavedPageKey || 'NavMapPage');
                }
            } catch (e) {}
            return;
        }

        // Entering MFD Reversionary Mode
        ensureMfdNativeReversionaryMounted(function (ok) {
            const latestEff = computeEffectiveAvionicsFailureState();
            if (!ok || !latestEff.mfdReversionary) return;
            if (failureRuntime.mfdReversionaryActive) return;
            failureRuntime.mfdReversionaryActive = true;

            const curMfd = document.querySelector('wtg1000-mfd');
            if (curMfd && curMfd.viewService) {
                try {
                    const curPage = curMfd.viewService.openPageKey ? curMfd.viewService.openPageKey.get() : '';
                    if (curPage) failureRuntime.mfdSavedPageKey = curPage;
                    curMfd.viewService.clearStack(true);
                } catch (e) {}
            }

            if (document.body.classList) {
                document.body.classList.add('wt-mfd-reversionary-active');
            }
            if (typeof document.body.setAttribute === 'function') {
                document.body.setAttribute('reversionary', 'true');
            }

            // Configure Reversionary OAT & Inset Map layout immediately (matching Garmin Fig. 1-5)
            try {
                const pfdMod = failureRuntime.mfdRevPfdMod;
                if (curMfd && pfdMod && pfdMod.PFDUserSettings && pfdMod.PfdMapLayoutSettingMode) {
                    const mapLayoutSetting = pfdMod.PFDUserSettings.getManager(curMfd.bus).getSetting('mapLayout');
                    if (!failureRuntime.mfdFirstRevEntryDone) {
                        failureRuntime.mfdFirstRevEntryDone = true;
                        if (mapLayoutSetting.value === pfdMod.PfdMapLayoutSettingMode.Off) {
                            mapLayoutSetting.value = pfdMod.PfdMapLayoutSettingMode.Inset;
                        }
                    }
                    const mode = mapLayoutSetting.value;
                    if (failureRuntime.mfdRevMapInsetRef && failureRuntime.mfdRevMapInsetRef.instance) {
                        const mi = failureRuntime.mfdRevMapInsetRef.instance;
                        if (mi.el && mi.el.instance) mi.el.instance.classList.add('reversionary');
                        if (mi.mapSize) mi.mapSize.set(312, 230);
                        mi.setVisible(mode === pfdMod.PfdMapLayoutSettingMode.Inset || mode === pfdMod.PfdMapLayoutSettingMode.TFC);
                    }
                    if (failureRuntime.mfdRevHsiRef && failureRuntime.mfdRevHsiRef.instance && failureRuntime.mfdRevHsiRef.instance.mapRef && failureRuntime.mfdRevHsiRef.instance.mapRef.instance) {
                        failureRuntime.mfdRevHsiRef.instance.mapRef.instance.setVisible(mode === pfdMod.PfdMapLayoutSettingMode.HSI);
                    }
                }
                if (failureRuntime.mfdRevBipRef && failureRuntime.mfdRevBipRef.instance && failureRuntime.mfdRevBipRef.instance.tempBox && failureRuntime.mfdRevBipRef.instance.tempBox.instance) {
                    failureRuntime.mfdRevBipRef.instance.tempBox.instance.classList.add('reversionary');
                }
                if (failureRuntime.mfdRevRootMenu) {
                    failureRuntime.mfdRevRootMenu.getItem(0).label.set('Engine');
                    failureRuntime.mfdRevRootMenu.getItem(0).handler = function () {
                        if (menuSys) menuSys.pushMenu('engine-menu');
                    };
                }
            } catch (e) {}

            try {
                const curMenuSys = (failureRuntime.binder && failureRuntime.binder.menuSystem) || pluginMenuSystem;
                if (curMenuSys && typeof curMenuSys.clear === 'function') {
                    curMenuSys.clear();
                    curMenuSys.pushMenu('rev-pfd-root');
                }
            } catch (e) {}

            // Force immediate failure/Red-X/integrity pass onto the newly mounted Reversionary PFD instruments
            failureRuntime.lastStateSig = '';
            failureRuntime.lastBusStates = {};
            applyAvionicsFailureStateToDisplay(latestEff);
        });
    }

    function publishLiveReversionaryDomTelemetry() {
        try {
            if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
            const rectOf = function (sel) {
                const el = document.querySelector(sel);
                if (!el || typeof el.getBoundingClientRect !== 'function') return null;
                return el.getBoundingClientRect();
            };
            if (failureRuntime.isMfd) {
                safeSetSimVar('L:WTG1000_DBG_MFD_REV_MOUNTED', 'Number', failureRuntime.mfdRevMounted ? 1 : 0);
                safeSetSimVar('L:WTG1000_DBG_MFD_REV_ACTIVE', 'Number', failureRuntime.mfdReversionaryActive ? 1 : 0);
                if (!failureRuntime.mfdReversionaryActive) {
                    safeSetSimVar('L:WTG1000_DBG_MFD_REV_DOM_MASK', 'Number', 0);
                    return;
                }
                let mask = 0;
                const rHorWrap = rectOf('#HorizonContainer');
                const rAtt = rectOf('#HorizonContainer .attitude-container');
                if (rHorWrap && rHorWrap.width >= 1000 && rHorWrap.height >= 750 && rAtt && rAtt.left >= 240 && rAtt.width >= 400 && rAtt.height >= 300) mask |= 1;
                const rAs = rectOf('.airspeed');
                if (rAs && rAs.left >= 150 && rAs.width >= 80 && rAs.height >= 350) mask |= 2;
                const rAlt = rectOf('.altimeter');
                if (rAlt && rAlt.left >= 680 && rAlt.width >= 100 && rAlt.height >= 350) mask |= 4;
                const rVsi = rectOf('.vsi-container');
                if (rVsi && rVsi.left >= 790 && rVsi.height >= 250) mask |= 8;
                const rHsi = rectOf('#HSI');
                if (rHsi && rHsi.width >= 300 && rHsi.height >= 300) mask |= 16;
                const rFma = rectOf('#NavComBoxCenter');
                const rNdb = rectOf('#NavComBox .nav-data-bar-container');
                if (rFma && rFma.left >= 250 && rFma.width >= 490 && rFma.height >= 50 && (!rNdb || rNdb.width === 0)) mask |= 32;
                const rOat = rectOf('.bottom-info-panel .bip-temp-box');
                const rXpdr = rectOf('.xpdr-container');
                if (rOat && rOat.left >= 150 && rOat.width >= 95 && rXpdr && rXpdr.width >= 100) mask |= 64;
                const rInset = rectOf('.map-inset.reversionary');
                if (rInset && rInset.width >= 308 && rInset.height >= 225 && rInset.right >= 1000) mask |= 128;
                const rEis = rectOf('.eis');
                if (rEis && rEis.left < 10 && rEis.width >= 145 && rEis.height >= 550) mask |= 256;
                const skLabels = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('.softkey-tab-label') : [];
                if (skLabels.length >= 12 && skLabels[0].textContent === 'Engine' && skLabels[1].textContent === 'Map/HSI' && skLabels[5].textContent === 'CDI') mask |= 512;
                safeSetSimVar('L:WTG1000_DBG_MFD_REV_DOM_MASK', 'Number', mask);
            } else if (failureRuntime.isPfd) {
                if (!failureRuntime.pfdReversionaryActive) {
                    safeSetSimVar('L:WTG1000_DBG_PFD_REV_DOM_OK', 'Number', 0);
                } else {
                    const rEis = rectOf('.eis:not(.hidden)');
                    const rOat = rectOf('.bip-temp-box.reversionary');
                    const ok = (rEis && rEis.width >= 140 && rEis.height >= 500 && rOat && rOat.left >= 150) ? 1 : 0;
                    safeSetSimVar('L:WTG1000_DBG_PFD_REV_DOM_OK', 'Number', ok);
                }
            }
        } catch (e) {}
    }

    function pubSystemStateIfChanged(pub, key, topic, index, desiredState) {
        const prev = failureRuntime.lastBusStates[key] || 'On';
        if (prev === desiredState) return;
        failureRuntime.lastBusStates[key] = desiredState;
        failureRuntime.applyingBusGuard = true;
        try {
            pub.pub(topic, { index: index, previous: prev || 'On', current: desiredState }, false, true);
        } catch (e) {}
        failureRuntime.applyingBusGuard = false;
    }

    function enforceAutopilotFailureLimits(eff) {
        if (typeof SimVar === 'undefined' || (!failureRuntime.isPfd && !eff.gdu1Fail)) return;
        try {
            const apOn = Number(SimVar.GetSimVarValue('AUTOPILOT MASTER', 'Bool') || 0) > 0;
            if (apOn && eff.apMustDisconnect) {
                SimVar.SetSimVarValue('K:AUTOPILOT_OFF', 'Number', 0);
                return;
            }
            if (apOn && eff.hdgInvalid) {
                const hdgLock = Number(SimVar.GetSimVarValue('AUTOPILOT HEADING LOCK', 'Bool') || 0) > 0;
                if (hdgLock) SimVar.SetSimVarValue('K:AP_HDG_HOLD_OFF', 'Number', 0);
            }
            if (apOn && eff.cdiNeedleHidden) {
                const navLock = Number(SimVar.GetSimVarValue('AUTOPILOT NAV1 LOCK', 'Bool') || 0) > 0;
                if (navLock) SimVar.SetSimVarValue('K:AP_NAV1_HOLD_OFF', 'Number', 0);
            }
            if (apOn && (eff.gsInhibited || eff.gpInhibited)) {
                const aprHold = Number(SimVar.GetSimVarValue('AUTOPILOT APPROACH HOLD', 'Bool') || 0) > 0;
                const gsHold = Number(SimVar.GetSimVarValue('AUTOPILOT GLIDESLOPE HOLD', 'Bool') || 0) > 0;
                if (aprHold || gsHold) SimVar.SetSimVarValue('K:AP_APR_HOLD_OFF', 'Number', 0);
            }
        } catch (e) {}
    }

    function applyAvionicsFailureStateToDisplay(eff) {
        ensureFailureSystemDomStyles();

        // Update pitot/static lock snapshots before anything else
        if (eff.pitotBlocked && !failureRuntime.pitotLocked) {
            failureRuntime.pitotLocked = true;
            failureRuntime.pitotLockIasKts = failureRuntime.rawIasKts;
            failureRuntime.pitotLockPressAltFt = failureRuntime.rawPressAltFt;
        } else if (!eff.pitotBlocked) {
            failureRuntime.pitotLocked = false;
        }
        if (eff.staticBlocked && !failureRuntime.staticLocked) {
            failureRuntime.staticLocked = true;
            failureRuntime.staticLockIndAltFt = failureRuntime.rawIndAltFt;
            failureRuntime.staticLockPressAltFt = failureRuntime.rawPressAltFt;
        } else if (!eff.staticBlocked) {
            failureRuntime.staticLocked = false;
        }

        // Enforce AP servo / sensor disconnects on every tick
        enforceAutopilotFailureLimits(eff);

        // Publish telemetry L:Vars for external Instructor Station
        const expectedAlerts = buildExpectedSystemAlerts(eff);
        safeSetSimVar('L:WTG1000_EFFECTIVE_LRU_MASK', 'Number', eff.effectiveLruMask);
        safeSetSimVar('L:WTG1000_ACTIVE_ALERT_COUNT', 'Number', expectedAlerts.length);
        safeSetSimVar('L:WTG1000_GPS_DR_ACTIVE', 'Number', eff.drMode ? 1 : 0);
        safeSetSimVar('L:WTG1000_GPS_LOI_ACTIVE', 'Number', eff.gpsLoi ? 1 : 0);
        safeSetSimVar('L:WTG1000_REVERSIONARY_ACTIVE', 'Number', eff.displayBackup ? 1 : 0);

        // Handle GPS INTEG OK 5-second window on recovery from GPS LOI (Table 2-4, p. 69)
        const nowMs = Date.now();
        if (eff.gpsLoi) {
            failureRuntime.wasGpsLoi = true;
            failureRuntime.gpsIntegOkUntilMs = 0;
        } else if (failureRuntime.wasGpsLoi) {
            failureRuntime.wasGpsLoi = false;
            failureRuntime.gpsIntegOkUntilMs = nowMs + 5000;
        }
        const showGpsIntegOk = !eff.gpsLoi && nowMs < failureRuntime.gpsIntegOkUntilMs;

        const sig = [
            eff.effectiveLruMask, eff.rawExtraMask, eff.displayBackup ? 1 : 0,
            eff.attInvalid ? 1 : 0, eff.attAligning ? 1 : 0, eff.hdgInvalid ? 1 : 0,
            eff.iasInvalid ? 1 : 0, eff.altInvalid ? 1 : 0, eff.oatInvalid ? 1 : 0, eff.tasInvalid ? 1 : 0,
            eff.gpsLoi ? 1 : 0, showGpsIntegOk ? 1 : 0, eff.drMode ? 1 : 0, eff.noGpsPos ? 1 : 0,
            eff.gpInhibited ? 1 : 0, eff.gsInhibited ? 1 : 0, eff.cdiNeedleHidden ? 1 : 0,
            eff.afcsAlertBadge, eff.pfdBlanked ? 1 : 0, eff.mfdBlanked ? 1 : 0,
            eff.pfdReversionary ? 1 : 0, eff.mfdReversionary ? 1 : 0,
            failureRuntime.brg1SourceType, failureRuntime.brg1SourceIndex,
            failureRuntime.brg2SourceType, failureRuntime.brg2SourceIndex
        ].join('|');

        if (sig === failureRuntime.lastStateSig) {
            return;
        }
        failureRuntime.lastStateSig = sig;

        const bus = failureRuntime.bus;
        const pub = (bus && typeof bus.getPublisher === 'function') ? bus.getPublisher() : null;

        if (pub) {
            // 1. ADC & Airspeed/Altitude/Temp data-valid topics
            const desiredAdc = eff.gdc1Fail ? 'Failed' : 'On';
            pubSystemStateIfChanged(pub, 'adc', 'adc_state', 1, desiredAdc);
            pubSystemStateIfChanged(pub, 'adc1', 'adc_state_1', 1, desiredAdc);
            try {
                pub.pub('adc_airspeed_data_valid_1', !eff.iasInvalid, false, true);
                pub.pub('adc_altitude_data_valid_1', !eff.altInvalid, false, true);
                pub.pub('adc_temperature_data_valid_1', !eff.oatInvalid && !eff.tasInvalid, false, true);
            } catch (e) {}

            // 2. AHRS & Magnetometer (Note: keep ahrs_state 'On' when ONLY GMU1 fails so Attitude stays valid!)
            const desiredAhrs = eff.attInvalid ? 'Failed' : (eff.attAligning ? 'Initializing' : 'On');
            pubSystemStateIfChanged(pub, 'ahrs', 'ahrs_state', 1, desiredAhrs);
            pubSystemStateIfChanged(pub, 'mag', 'magnetometer_state', 1, eff.gmu1Fail ? 'Failed' : 'On');
            if (eff.gmu1Fail && desiredAhrs === 'On') {
                // Stock AHRSSystem sets ahrs_state='Failed' when magnetometer_state!='On'; immediately restore ahrs_state='On'!
                failureRuntime.lastBusStates.ahrs = 'Failed';
                pubSystemStateIfChanged(pub, 'ahrs', 'ahrs_state', 1, 'On');
            }

            // 3. GIA1 / GIA2, GEA1, GTX1
            pubSystemStateIfChanged(pub, 'gia1', 'avionicscomputer_state_1', 1, eff.gia1Fail ? 'Failed' : 'On');
            pubSystemStateIfChanged(pub, 'gia2', 'avionicscomputer_state_2', 2, eff.gia2Fail ? 'Failed' : 'On');
            pubSystemStateIfChanged(pub, 'gea1', 'engineairframe_state', 1, eff.gea1Fail ? 'Failed' : 'On');
            pubSystemStateIfChanged(pub, 'xpdr', 'transponder_state', 1, eff.gtx1Fail ? 'Failed' : 'On');

            // 4. Synchronize PFD & MFD Reversionary Alerts Window & Flashing Alerts Softkey
            if (failureRuntime.isPfd || failureRuntime.isMfd) {
                const nextMap = {};
                for (let i = 0; i < expectedAlerts.length; i++) {
                    const a = expectedAlerts[i];
                    nextMap[a.key] = a;
                    if (!failureRuntime.activeAlertKeys[a.key]) {
                        failureRuntime.activeAlertKeys[a.key] = true;
                        try {
                            pub.pub('alerts_push', { key: a.key, title: a.title, message: a.message }, true, false);
                        } catch (e) {}
                    }
                }
                const oldKeys = Object.keys(failureRuntime.activeAlertKeys);
                for (let i = 0; i < oldKeys.length; i++) {
                    const ok = oldKeys[i];
                    if (!nextMap[ok]) {
                        delete failureRuntime.activeAlertKeys[ok];
                        try {
                            pub.pub('alerts_remove', ok, true, false);
                        } catch (e) {}
                    }
                }
            }

            // 5. PFD Reversionary Mode (manual DISPLAY BACKUP pressed while PFD is operative)
            if (failureRuntime.isPfd && typeof document !== 'undefined' && document.body && eff.pfdReversionary !== failureRuntime.pfdReversionaryActive) {
                failureRuntime.pfdReversionaryActive = eff.pfdReversionary;
                const Sc = window.ScreenState || { ON: 3, REVERSIONARY: 4 };
                const pfdInst = typeof document.querySelector === 'function' ? document.querySelector('wtg1000-pfd') : null;
                const pfdEis = typeof document.querySelector === 'function' ? document.querySelector('.eis') : null;
                const pfdTemp = typeof document.querySelector === 'function' ? document.querySelector('.bip-temp-box') : null;
                const pfdInset = typeof document.querySelector === 'function' ? document.querySelector('.map-inset') : null;
                if (eff.pfdReversionary) {
                    if (typeof document.body.setAttribute === 'function') {
                        document.body.setAttribute('reversionary', 'true');
                    }
                    try {
                        pub.pub('mfd_power_on', false, false, true);
                        pub.pub('vc_screen_state', { current: Sc.REVERSIONARY || 4, previous: Sc.ON || 3 }, false, true);
                    } catch (e) {}
                    try {
                        if (pfdInst && pfdInst.eisXmlLogicHost && typeof pfdInst.eisXmlLogicHost.setIsPaused === 'function') {
                            pfdInst.eisXmlLogicHost.setIsPaused(false);
                        }
                        if (pfdEis && pfdEis.classList) pfdEis.classList.remove('hidden');
                        if (pfdTemp && pfdTemp.classList) pfdTemp.classList.add('reversionary');
                        if (pfdInset && pfdInset.classList) pfdInset.classList.add('reversionary');
                    } catch (e) {}
                } else {
                    if (typeof document.body.removeAttribute === 'function') {
                        document.body.removeAttribute('reversionary');
                    }
                    try {
                        pub.pub('mfd_power_on', true, false, true);
                        pub.pub('vc_screen_state', { current: Sc.ON || 3, previous: Sc.REVERSIONARY || 4 }, false, true);
                    } catch (e) {}
                    try {
                        if (pfdInst && pfdInst.eisXmlLogicHost && typeof pfdInst.eisXmlLogicHost.setIsPaused === 'function') {
                            pfdInst.eisXmlLogicHost.setIsPaused(true);
                        }
                        if (pfdEis && pfdEis.classList) pfdEis.classList.add('hidden');
                        if (pfdTemp && pfdTemp.classList) pfdTemp.classList.remove('reversionary');
                        if (pfdInset && pfdInset.classList) pfdInset.classList.remove('reversionary');
                    } catch (e) {}
                }
            }
        }

        // 6. Sync MapDataIntegrityModules (fixes single-GIA1 false NO GPS POSITION & GMU1 heading-only loss)
        syncMapDataIntegrityModules(eff);

        if (typeof document === 'undefined' || !document.body || typeof document.querySelector !== 'function') return;

        // 7. DOM Instrument Red Xs & Annunciations
        if (document.body.classList) {
            document.body.classList.toggle('wt-dr-amber-mode', eff.drMode);
            document.body.classList.toggle('wt-cdi-needle-hidden', eff.cdiNeedleHidden);
        }

        // Airspeed, TAS, Altimeter, VSI, OAT
        const asEl = document.querySelector('.airspeed');
        if (asEl) {
            asEl.classList.toggle('data-failed', eff.iasInvalid);
            setOrRemoveOverlay(asEl, 'wt-tas-fail-box', 'wt-redx-box', '', eff.tasInvalid && !eff.iasInvalid);
        }
        const altEl = document.querySelector('.altimeter');
        if (altEl) altEl.classList.toggle('failed-instr', eff.altInvalid);
        const vsiEl = document.querySelector('.vsi-container, .vsi');
        if (vsiEl) vsiEl.classList.toggle('failed-instr', eff.altInvalid);
        const oatEl = document.querySelector('.bip-temp-box');
        if (oatEl) oatEl.classList.toggle('failed-instr', eff.oatInvalid);

        // Heading-only Red X on HSI when GMU1 fails while Attitude stays valid
        const hsiRose = document.querySelector('.hsi-rose-container');
        if (hsiRose) hsiRose.classList.toggle('failed-instr', eff.hdgInvalid);
        const hsiMap = document.querySelector('.hsi-map-container');
        if (hsiMap) hsiMap.classList.toggle('failed-instr', eff.hdgInvalid);

        // Granular NAV1 / NAV2 / COM1 / COM2 Red Xs & Stuck Mic TX badge
        const qsa = typeof document.querySelectorAll === 'function' ? function (s) { return document.querySelectorAll(s); } : function () { return []; };
        const navBoxes = qsa('.Nav1 .navcom-frequencyelement-container');
        if (navBoxes.length >= 2) {
            navBoxes[0].classList.toggle('failed-instr', eff.nav1Fail);
            navBoxes[1].classList.toggle('failed-instr', eff.nav2Fail);
        }
        const comBoxes = qsa('.Com1 .navcom-frequencyelement-container');
        if (comBoxes.length >= 2) {
            comBoxes[0].classList.toggle('failed-instr', eff.com1Fail);
            comBoxes[1].classList.toggle('failed-instr', eff.com2Fail);
            setOrRemoveOverlay(comBoxes[0], 'wt-com1-ptt-badge', 'wt-ptt-stuck-badge', 'TX STUCK', eff.com1Ptt);
            setOrRemoveOverlay(comBoxes[1], 'wt-com2-ptt-badge', 'wt-ptt-stuck-badge', 'TX STUCK', eff.com2Ptt);
        }

        // Bearing Pointers 1 & 2 granular source invalidation
        const brg1El = document.querySelector('.left-brg-ptr-container');
        if (brg1El) {
            const b1Bad = (failureRuntime.brg1SourceType === 0 && ((failureRuntime.brg1SourceIndex === 1 && eff.nav1Fail) || (failureRuntime.brg1SourceIndex === 2 && eff.nav2Fail))) ||
                          (failureRuntime.brg1SourceType === 1 && eff.noGpsPos);
            brg1El.classList.toggle('failed-instr', b1Bad);
        }
        const brg2El = document.querySelector('.right-brg-ptr-container');
        if (brg2El) {
            const b2Bad = (failureRuntime.brg2SourceType === 0 && ((failureRuntime.brg2SourceIndex === 1 && eff.nav1Fail) || (failureRuntime.brg2SourceIndex === 2 && eff.nav2Fail))) ||
                          (failureRuntime.brg2SourceType === 1 && eff.noGpsPos);
            brg2El.classList.toggle('failed-instr', b2Bad);
        }

        // HSI GPS LOI / GPS INTEG OK / DR badge
        const gpsMsgEl = document.querySelector('#HSI .hsi-gps-msg');
        if (gpsMsgEl) {
            if (eff.gpsLoi) {
                gpsMsgEl.style.color = '#000000';
                gpsMsgEl.style.backgroundColor = '#ffd800';
                gpsMsgEl.textContent = 'GPS LOI';
                gpsMsgEl.classList.remove('hidden');
            } else if (showGpsIntegOk) {
                gpsMsgEl.style.color = '#ffffff';
                gpsMsgEl.style.backgroundColor = 'rgba(0, 0, 0, 0.82)';
                gpsMsgEl.textContent = 'GPS INTEG OK';
                gpsMsgEl.classList.remove('hidden');
            } else {
                gpsMsgEl.classList.add('hidden');
            }
        }

        const hsiRoot = document.getElementById('HSI');
        setOrRemoveOverlay(hsiRoot, 'wt-hsi-dr-badge', '', 'DR', eff.drMode);

        // Map own-ship DR overlay on PFD Inset Map & MFD Nav Map
        const mapEls = qsa('.nav-map-container, .pfd-insetmap-container, #Map');
        for (let i = 0; i < mapEls.length; i++) {
            setOrRemoveOverlay(mapEls[i], 'wt-map-dr-badge-' + i, 'wt-map-dr-badge', 'DR', eff.drMode);
        }

        // Attitude TAWS N/A or TAWS FAIL banner (Fig. 5-85, p. 237)
        const attRoot = document.querySelector('.attitude-container.Horizon');
        const tawsText = eff.tawsFail ? 'TAWS FAIL' : (eff.gpsBothFail ? 'TAWS N/A' : '');
        setOrRemoveOverlay(attRoot, 'wt-taws-banner', '', tawsText, Boolean(tawsText) && !eff.attInvalid && !eff.attAligning);

        // GMA1 Audio Panel Fail-Safe banner
        setOrRemoveOverlay(document.body, 'wt-gma1-banner', '', 'AUDIO FAIL-SAFE: COM1 ONLY', eff.gma1Fail && (failureRuntime.isPfd || eff.mfdReversionary));

        // Transponder XPDR FAIL Red X (Table 1-1, p. 12)
        const xpdrEl = document.querySelector('.xpdr-container');
        setOrRemoveOverlay(xpdrEl, 'wt-xpdr-fail-box', 'wt-redx-box', 'XPDR FAIL', eff.gtx1Fail);

        // Vertical Deviation (GS / GP) Red X
        const vdevEl = document.querySelector('.vertical-deviation, .vdev-box, [class*="vertical-deviation"]');
        const vdevFailLabel = eff.gsInhibited ? 'G/S' : (eff.gpInhibited ? 'GP' : '');
        setOrRemoveOverlay(vdevEl, 'wt-vdev-fail-box', 'wt-redx-box', vdevFailLabel, Boolean(vdevFailLabel));

        // AFCS Status Box Red Alert (PTCH, ROLL, PTRM, AFCS, PFT — Table 7-6, p. 369)
        const fmaApBox = document.getElementById('CenterBarBottomMiddle');
        setOrRemoveOverlay(fmaApBox, 'wt-afcs-fail-badge', '', eff.afcsAlertBadge, Boolean(eff.afcsAlertBadge));

        // GEA1 Engine Indication System (EIS) Red X Overlays
        const eisEl = document.querySelector('.eis');
        const eisFailHtml =
            '<div class="wt-eis-fail-cell"><span>RPM</span><span>----</span></div>' +
            '<div class="wt-eis-fail-cell"><span>FFLOW / OIL</span><span>---</span></div>' +
            '<div class="wt-eis-fail-cell"><span>EGT / CHT</span><span>---</span></div>' +
            '<div class="wt-eis-fail-cell"><span>FUEL QTY</span><span>---</span></div>' +
            '<div class="wt-eis-fail-cell"><span>VAC / ELEC</span><span>---</span></div>';
        setOrRemoveOverlay(eisEl, 'wt-eis-fail-overlay', '', eisFailHtml, eff.gea1Fail);

        // GDU1 / GDU2 Display Blanking & Native MFD Reversionary Flight Display
        const thisDisplayBlanked = (failureRuntime.isPfd && eff.pfdBlanked) || (failureRuntime.isMfd && eff.mfdBlanked);
        setOrRemoveOverlay(document.body, 'wt-gdu-poweroff-overlay', '', '', thisDisplayBlanked);
        syncMfdNativeReversionaryMode(eff);
    }

    function installAvionicsFailureSystem(binder) {
        try {
            if (failureRuntime.installed) return;
            failureRuntime.installed = true;
            failureRuntime.binder = binder || null;
            failureRuntime.bus = binder && binder.bus ? binder.bus : null;
            failureRuntime.fms = binder && binder.fms ? binder.fms : submenuFms;
            failureRuntime.isPfd = Boolean(window.g1000nxipfd || (typeof document !== 'undefined' && document.getElementById && document.getElementById('HorizonContainer')));
            failureRuntime.isMfd = Boolean(!failureRuntime.isPfd);

            patchMapDataIntegrityForFailures();

            const bus = failureRuntime.bus;
            if (bus && typeof bus.pub === 'function' && !bus.__wtg1000BlockageWrapped) {
                bus.__wtg1000BlockageWrapped = true;
                const origBusPub = bus.pub;
                bus.pub = function (topic, data, sync, cached) {
                    try {
                        if (topic === 'ias' || topic === 'ias_1') {
                            failureRuntime.rawIasKts = Number(data) || 0;
                        } else if (topic === 'indicated_alt' || topic === 'indicated_alt_1') {
                            failureRuntime.rawIndAltFt = Number(data) || 0;
                        } else if (topic === 'pressure_alt') {
                            failureRuntime.rawPressAltFt = Number(data) || 0;
                        }
                        if (failureRuntime.pitotLocked || failureRuntime.staticLocked) {
                            if (failureRuntime.staticLocked && (topic === 'indicated_alt' || topic === 'indicated_alt_1' || topic === 'adc_indicated_alt_1')) {
                                data = failureRuntime.staticLockIndAltFt;
                            } else if (failureRuntime.staticLocked && (topic === 'vertical_speed' || topic === 'adc_vertical_speed_1')) {
                                data = 0;
                            } else if (topic === 'ias' || topic === 'ias_1' || topic === 'adc_ias_1') {
                                data = computePitotStaticIas(
                                    failureRuntime.rawIasKts,
                                    failureRuntime.rawPressAltFt || failureRuntime.rawIndAltFt,
                                    failureRuntime.pitotLocked,
                                    failureRuntime.pitotLockIasKts,
                                    failureRuntime.pitotLockPressAltFt,
                                    failureRuntime.staticLocked,
                                    failureRuntime.staticLockPressAltFt
                                );
                            }
                        }
                    } catch (e) {}
                    return origBusPub.call(this, topic, data, sync, cached);
                };
            }

            if (bus && typeof bus.getSubscriber === 'function') {
                const sub = bus.getSubscriber();
                try {
                    sub.on('cdi_select').handle(function (src) {
                        if (src) {
                            failureRuntime.cdiIsGps = (src.type === (sdk.NavSourceType ? sdk.NavSourceType.Gps : 1));
                            failureRuntime.cdiNavIndex = Number(src.index) || 1;
                            failureRuntime.lastStateSig = '';
                        }
                    });
                } catch (e) {}
                try {
                    sub.on('lnavdata_cdi_scale_label').handle(function (lbl) {
                        failureRuntime.cdiScaleLabel = String(lbl || 'ENR');
                    });
                } catch (e) {}
                try {
                    sub.on('brg_source').handle(function (b) {
                        if (!b) return;
                        const sType = b.source ? b.source.type : -1;
                        const sIdx = b.source ? (Number(b.source.index) || 1) : 1;
                        const normType = (b.source === null || b.source === undefined) ? -1 : (sType === (sdk.NavSourceType ? sdk.NavSourceType.Nav : 0) ? 0 : 1);
                        if (b.index === 0) {
                            failureRuntime.brg1SourceType = normType;
                            failureRuntime.brg1SourceIndex = sIdx;
                        } else if (b.index === 1) {
                            failureRuntime.brg2SourceType = normType;
                            failureRuntime.brg2SourceIndex = sIdx;
                        }
                    });
                } catch (e) {}

                // Guard against stock BasicAvionicsSystem initialization timers overwriting active failures
                const guardTopics = ['adc_state', 'ahrs_state', 'avionicscomputer_state_1', 'avionicscomputer_state_2', 'engineairframe_state', 'transponder_state'];
                for (let g = 0; g < guardTopics.length; g++) {
                    (function (tName) {
                        try {
                            sub.on(tName).handle(function (st) {
                                if (failureRuntime.applyingBusGuard || !st || st.current === 'Off') return;
                                const eff = computeEffectiveAvionicsFailureState();
                                if (eff.effectiveLruMask !== 0 || eff.rawExtraMask !== 0) {
                                    failureRuntime.lastStateSig = '';
                                    applyAvionicsFailureStateToDisplay(eff);
                                }
                            });
                        } catch (e) {}
                    })(guardTopics[g]);
                }
            }

            try {
                failureRuntime.lastFmsCmd = (typeof SimVar !== 'undefined')
                    ? Math.round(Number(SimVar.GetSimVarValue('L:WTG1000_IFR_FMS_CMD', 'Number') || 0))
                    : 0;
            } catch (e) {
                failureRuntime.lastFmsCmd = 0;
            }

            if (typeof setInterval === 'function') {
                setInterval(function () {
                    try {
                        applyAvionicsFailureStateToDisplay(computeEffectiveAvionicsFailureState());
                        publishLiveReversionaryDomTelemetry();
                        pollInstructorStationFmsBridge();
                    } catch (e) {}
                }, 200);
            }
            if (typeof setTimeout === 'function') {
                setTimeout(function () {
                    failureRuntime.lastStateSig = '';
                    applyAvionicsFailureStateToDisplay(computeEffectiveAvionicsFailureState());
                }, 1200);
            }
            applyAvionicsFailureStateToDisplay(computeEffectiveAvionicsFailureState());
        } catch (e) {
            console.error('WTG1000NxiEnhancements: installAvionicsFailureSystem error', e);
        }
    }

    function extractActiveFmsRouteWaypoints(fmsArg) {
        const fms = fmsArg || failureRuntime.fms || submenuFms;
        const fp = (window.planner && typeof window.planner.hasActiveFlightPlan === 'function' && window.planner.hasActiveFlightPlan())
            ? window.planner.getActiveFlightPlan()
            : (fms && typeof fms.hasPrimaryFlightPlan === 'function' && fms.hasPrimaryFlightPlan() ? fms.getPrimaryFlightPlan() : null);
        if (!fp || !fp.length) {
            return { ok: false, waypoints: [], airways: [] };
        }
        const waypoints = [];
        const airways = [];
        for (let i = 0; i < fp.length; i++) {
            const legDef = typeof fp.tryGetLeg === 'function' ? fp.tryGetLeg(i) : null;
            if (!legDef || !legDef.leg) continue;
            const fixIcao = String(legDef.leg.fixIcao || '');
            if (!fixIcao.trim()) continue;
            let ident = '';
            try {
                ident = sdk.ICAO.getIdent(fixIcao).trim().toUpperCase();
            } catch (e) {
                ident = String(legDef.name || '').trim().toUpperCase();
            }
            if (!ident || ident === 'HOLD' || ident === 'MANSEQ' || ident === 'USR') continue;
            let lat = (legDef.calculated && typeof legDef.calculated.endLat === 'number') ? legDef.calculated.endLat : null;
            let lon = (legDef.calculated && typeof legDef.calculated.endLon === 'number') ? legDef.calculated.endLon : null;
            if ((typeof lat !== 'number' || isNaN(lat)) && facilityDirectory.has(fixIcao)) {
                const dirEntry = facilityDirectory.get(fixIcao);
                lat = dirEntry.lat;
                lon = dirEntry.lon;
            }
            if ((typeof lat !== 'number' || isNaN(lat)) && fms && fms.facLoader && fms.facLoader.facilityRepo && typeof fms.facLoader.facilityRepo.get === 'function') {
                try {
                    const rf = fms.facLoader.facilityRepo.get(fixIcao);
                    if (rf && typeof rf.lat === 'number') { lat = rf.lat; lon = rf.lon; }
                } catch (e) {}
            }
            if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) continue;
            if (waypoints.length > 0 && waypoints[waypoints.length - 1].ident === ident) continue;

            let segAirway = 'DCT';
            try {
                if (typeof fp.getSegmentFromLeg === 'function') {
                    const seg = fp.getSegmentFromLeg(legDef);
                    if (seg && seg.airway) segAirway = String(seg.airway).split('.')[0].trim().toUpperCase() || 'DCT';
                }
            } catch (e) {}

            const code = fixIcao.charAt(0);
            const fixType = code === 'A' ? 'AIRPORT' : (code === 'V' ? 'VOR' : 'FIX');
            if (waypoints.length > 0) {
                airways.push(segAirway);
            }
            waypoints.push({ ident: ident, lat: lat, lon: lon, fix_type: fixType });
        }
        return { ok: waypoints.length > 0, waypoints: waypoints, airways: airways };
    }

    async function applyInstructorRouteToFms(fmsArg, fixes) {
        const fms = fmsArg || failureRuntime.fms || submenuFms;
        if (!fms || !Array.isArray(fixes) || fixes.length === 0) {
            return { ok: false, count: 0, idents: [], error: 'FMS unavailable or empty fixes' };
        }
        if (typeof fms.cancelDirectTo === 'function') {
            try { fms.cancelDirectTo(); } catch (e) {}
        }
        await fms.emptyPrimaryFlightPlan();
        if (fms.flightPlanner && typeof fms.flightPlanner.setActivePlanIndex === 'function') {
            try { fms.flightPlanner.setActivePlanIndex(0); } catch (e) {}
        }
        const resolved = [];
        for (let i = 0; i < fixes.length; i++) {
            const wp = fixes[i];
            const ident = String((wp && wp.ident) || '').trim().toUpperCase();
            if (!ident) continue;
            const targetLat = Number(wp.lat);
            const targetLon = Number(wp.lon);
            let fac = null;

            if (fms.facLoader && fms.facLoader.facilityRepo && typeof fms.facLoader.facilityRepo.forEach === 'function') {
                let bestDist = Infinity;
                fms.facLoader.facilityRepo.forEach(function (cand) {
                    try {
                        const cid = sdk.ICAO.getIdent(cand.icao).trim().toUpperCase();
                        if (cid === ident && typeof cand.lat === 'number' && typeof cand.lon === 'number') {
                            const d = Math.hypot(cand.lat - targetLat, cand.lon - targetLon);
                            if (d < bestDist && d < 2.0) {
                                bestDist = d;
                                fac = cand;
                            }
                        }
                    } catch (e) {}
                });
            }
            if (!fac && fms.facLoader && typeof fms.facLoader.searchByIdent === 'function' && sdk.FacilitySearchType) {
                try {
                    const icaos = await fms.facLoader.searchByIdent(sdk.FacilitySearchType.All, ident, 15);
                    if (Array.isArray(icaos)) {
                        let bestDist = Infinity;
                        for (let k = 0; k < icaos.length; k++) {
                            try {
                                const fType = sdk.ICAO.getFacilityType(icaos[k]);
                                const cand = await fms.facLoader.getFacility(fType, icaos[k]);
                                if (cand && typeof cand.lat === 'number' && typeof cand.lon === 'number') {
                                    const d = Math.hypot(cand.lat - targetLat, cand.lon - targetLon);
                                    if (d < bestDist && d < 2.0) {
                                        bestDist = d;
                                        fac = cand;
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            }
            if (!fac && sdk.UserFacilityUtils && typeof sdk.UserFacilityUtils.createFromLatLon === 'function') {
                const cleanId = ident.replace(/[^A-Z0-9]/g, '').slice(0, 5).padEnd(5, ' ');
                const uIcao = 'U      ' + cleanId;
                fac = sdk.UserFacilityUtils.createFromLatLon(uIcao, targetLat, targetLon, false, ident);
                if (typeof fms.addUserFacility === 'function') {
                    try { fms.addUserFacility(fac); } catch (e) {}
                }
            }
            if (fac) {
                resolved.push({ ident: ident, fac: fac });
            }
        }
        const plan = fms.getPrimaryFlightPlan();
        let enrouteSegIdx = 1;
        try {
            if (plan && typeof plan.segmentsOfType === 'function' && sdk.FlightPlanSegmentType) {
                const firstEnr = plan.segmentsOfType(sdk.FlightPlanSegmentType.Enroute).next().value;
                if (firstEnr && typeof firstEnr.segmentIndex === 'number') {
                    enrouteSegIdx = firstEnr.segmentIndex;
                }
            }
        } catch (e) {}

        for (let i = 0; i < resolved.length; i++) {
            try { fms.insertWaypoint(enrouteSegIdx, resolved[i].fac); } catch (e) {}
        }
        if (plan && typeof plan.calculate === 'function') {
            await plan.calculate(0);
        }
        let activated = false;
        if (typeof fms.activateNearestLeg === 'function') {
            try { activated = fms.activateNearestLeg(); } catch (e) {}
        }
        if (!activated && resolved.length >= 2 && typeof fms.activateLeg === 'function') {
            try { fms.activateLeg(enrouteSegIdx, 1); } catch (e) {}
        }
        publishFlightPlanDiagnostics();
        return {
            ok: resolved.length > 0,
            count: resolved.length,
            idents: resolved.map(function (r) { return r.ident; })
        };
    }

    function postJsonToLocalInstructor(url, obj) {
        try {
            if (typeof XMLHttpRequest === 'undefined') return;
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(obj));
        } catch (e) {}
    }

    function pollInstructorStationFmsBridge() {
        if (typeof SimVar === 'undefined' || typeof XMLHttpRequest === 'undefined') return;
        const cmdVal = Math.round(Number(SimVar.GetSimVarValue('L:WTG1000_IFR_FMS_CMD', 'Number') || 0));
        if (cmdVal <= 0 || cmdVal === failureRuntime.lastFmsCmd) return;
        failureRuntime.lastFmsCmd = cmdVal;

        const port = Math.round(Number(SimVar.GetSimVarValue('L:WTG1000_IFR_SERVER_PORT', 'Number') || 8780)) || 8780;
        const baseUrl = 'http://127.0.0.1:' + port;
        const eff = computeEffectiveAvionicsFailureState();
        const isPrimaryReporter = failureRuntime.isMfd || (failureRuntime.isPfd && eff.gdu2Fail);

        if ((cmdVal % 2) === 1) {
            // Odd cmdVal = Pull Active Sim FMS Route -> Instructor Station
            if (!isPrimaryReporter) return;
            const res = extractActiveFmsRouteWaypoints(null);
            postJsonToLocalInstructor(baseUrl + '/api/fms-bridge/pull-report', {
                cmdId: cmdVal,
                ok: res.ok,
                waypoints: res.waypoints,
                airways: res.airways,
                source: 'Working Title G1000 NXi Active FMS'
            });
        } else {
            // Even cmdVal = Push Instructor Station Route -> Active Sim FMS
            // Execute ONLY on primary reporter (MFD, or PFD when MFD is failed) because WT FlightPlanner automatically syncs primary plan across EventBus!
            if (!isPrimaryReporter) return;
            fetchTextFileViaXhr(baseUrl + '/api/fms-bridge/pending-push', function (rawJson) {
                if (!rawJson) return;
                try {
                    const data = JSON.parse(rawJson);
                    if (!data || !Array.isArray(data.fixes)) return;
                    applyInstructorRouteToFms(null, data.fixes).then(function (ack) {
                        postJsonToLocalInstructor(baseUrl + '/api/fms-bridge/push-ack', {
                            cmdId: cmdVal,
                            ok: ack.ok,
                            count: ack.count,
                            idents: ack.idents
                        });
                    }).catch(function () {});
                } catch (e) {}
            });
        }
    }

    window.__WTG1000_FAILURE_ENGINE__ = {
        LRU_BIT: FAIL_LRU_BIT,
        EXTRA_BIT: FAIL_EXTRA_BIT,
        computeEffectiveAvionicsFailureState: computeEffectiveAvionicsFailureState,
        buildExpectedSystemAlerts: buildExpectedSystemAlerts,
        computePitotStaticIas: computePitotStaticIas,
        applyAvionicsFailureStateToDisplay: applyAvionicsFailureStateToDisplay,
        scopePfdCssForMfdReversionary: scopePfdCssForMfdReversionary,
        patchPfdJsForMfdReversionary: patchPfdJsForMfdReversionary,
        mountMfdReversionaryComponentsWithSources: mountMfdReversionaryComponentsWithSources,
        syncMfdNativeReversionaryMode: syncMfdNativeReversionaryMode,
        extractActiveFmsRouteWaypoints: extractActiveFmsRouteWaypoints,
        applyInstructorRouteToFms: applyInstructorRouteToFms,
        runtime: failureRuntime
    };

    if (shouldInstallG1000Enhancements) {
        installAltOuterKnobApproachSnap();
        patchMapDataIntegrityForFailures();
    }


    class WTG1000NxiEnhancementsPlugin extends BasePlugin {
        onPageSelectMenuSystemInitialized() {
            try {
                try {
                    const supFn = BasePlugin.prototype && BasePlugin.prototype.onPageSelectMenuSystemInitialized;
                    if (typeof supFn === 'function') {
                        supFn.call(this);
                    }
                } catch (e) {}
                if (shouldInstallG1000Enhancements && this.binder && this.binder.pageSelectMenuSystem) {
                    activateMediumPageSelectEntries(this.binder.pageSelectMenuSystem);
                }
            } catch (e) {}
        }

        onMenuSystemInitialized() {
            try {
                try {
                    const supFn = BasePlugin.prototype && BasePlugin.prototype.onMenuSystemInitialized;
                    if (typeof supFn === 'function') {
                        supFn.call(this);
                    }
                } catch (e) {}
                if (shouldInstallG1000Enhancements && this.binder && this.binder.menuSystem) {
                    installEasyUsabilityMenuHooks(this.binder.menuSystem);
                }
                if (shouldInstallG1000Enhancements && this.binder && this.binder.viewService) {
                    registerMediumMfdPages(this.binder.viewService);
                }
            } catch (e) {}
        }

        onViewServiceInitialized() {
            try {
                try {
                    const supFn = BasePlugin.prototype && BasePlugin.prototype.onViewServiceInitialized;
                    if (typeof supFn === 'function') {
                        supFn.call(this);
                    }
                } catch (e) {}
                if (shouldInstallG1000Enhancements && this.binder && this.binder.viewService) {
                    wireSubmenuViewService(this.binder.viewService);
                    registerMediumMfdPages(this.binder.viewService);
                }
            } catch (e) {}
        }

        onInstalled() {
            try {
                if (!shouldInstallG1000Enhancements) {
                    return;
                }
                const binder = this.binder;
                if (binder && binder.fms) {
                    installFmsMissedApproachFix(binder.fms);
                }
                patchLNavComputerPrototype();
                patchFmsUtilsArrowDisplay();
                patchSelectApproachUi();
                installWaypointSubmenuSupport(binder);
                installEasyUsabilityBusHooks(binder);
                installMediumUsabilitySupport(binder);
                installAltOuterKnobApproachSnap();
                installIlsNavToNavFix(binder);
                installAvionicsFailureSystem(binder);
                if (binder && binder.menuSystem) {
                    installEasyUsabilityMenuHooks(binder.menuSystem);
                }
                safeSetSimVar('L:WTG1000_MOD_ALIVE', 'Number', 800);
                safeSetSimVar('L:CT182T_PLUGIN_ALIVE', 'Number', 800);
            } catch (e) {
                console.error('WTG1000NxiEnhancementsPlugin: onInstalled error', e);
            }
        }
    }

    sdk.registerPlugin(WTG1000NxiEnhancementsPlugin);
})();
